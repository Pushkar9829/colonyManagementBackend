import mongoose from 'mongoose';
import LeaveRequest, { LEAVE_TYPES, PAID_LEAVE_TYPES } from './leaveRequest.model.js';
import LeaveBalance from './leaveBalance.model.js';
import Employee from './employee.model.js';
import Attendance from './attendance.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { ROLES } from '../../common/constants/index.js';
import * as audit from '../audit/audit.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import { dateRange, diffDays, isManagerRole, today } from '../assets/facility.shared.js';
import { findMine, getSettings } from './employees.service.js';

const MANAGERS = [ROLES.ADMIN, ROLES.FACILITY_MANAGER];
const POPULATE = [
  { path: 'employee', select: 'employeeCode designation department', populate: { path: 'user', select: 'name' } },
  { path: 'decidedBy', select: 'name' },
];

export const leaveDays = ({ from, to, halfDay }) => (halfDay ? 0.5 : diffDays(from, to) + 1);

// Allocation, used (approved), pending and available days per leave type for one year.
export async function balances(ctx, employeeIdRaw, year) {
  const employeeId = new mongoose.Types.ObjectId(String(employeeIdRaw));
  const [settings, override, usage] = await Promise.all([
    getSettings(ctx),
    LeaveBalance.findOne({ society: ctx.societyId, employee: employeeId, year }).lean(),
    LeaveRequest.aggregate([
      { $match: { society: ctx.societyId, employee: employeeId, year, status: { $in: ['approved', 'pending'] } } },
      { $group: { _id: { type: '$type', status: '$status' }, days: { $sum: '$days' } } },
    ]),
  ]);
  const used = (type, status) => usage.find((u) => u._id.type === type && u._id.status === status)?.days || 0;
  return LEAVE_TYPES.map((type) => {
    if (type === 'unpaid') return { type, allocated: null, used: used(type, 'approved'), pending: used(type, 'pending'), available: null };
    let allocated = override?.allocations?.[type] ?? settings.leaveQuota?.[type] ?? 0;
    if (type === 'earned') allocated += override?.carriedForward || 0;
    const u = used(type, 'approved');
    const p = used(type, 'pending');
    return { type, allocated, used: u, pending: p, available: Math.max(0, allocated - u - p) };
  });
}

async function employeeFor(ctx, employeeId) {
  if (!employeeId || !isManagerRole(ctx.role)) return findMine(ctx);
  const emp = await Employee.findOne({ _id: employeeId, society: ctx.societyId, status: 'active' }).lean();
  if (!emp) throw ApiError.notFound('Employee not found');
  return emp;
}

export async function myBalances(ctx, { year, employee: employeeId }) {
  const emp = await employeeFor(ctx, employeeId);
  const y = year || Number(today().slice(0, 4));
  return { year: y, employee: emp._id, balances: await balances(ctx, emp._id, y) };
}

async function assertAvailable(ctx, emp, { type, year, days }, excludePending = 0) {
  if (!PAID_LEAVE_TYPES.includes(type)) return;
  const row = (await balances(ctx, emp._id, year)).find((b) => b.type === type);
  if (days > row.available + excludePending) throw ApiError.conflict('Only {n} {type} leave day(s) left for {year}', { params: { n: row.available + excludePending, type, year } });
}

export async function apply(ctx, { employee: employeeId, ...data }) {
  const emp = await employeeFor(ctx, employeeId);
  const days = leaveDays(data);
  const year = Number(data.from.slice(0, 4));
  const clash = await LeaveRequest.findOne({ society: ctx.societyId, employee: emp._id, status: { $in: ['pending', 'approved'] }, from: { $lte: data.to }, to: { $gte: data.from } }).lean();
  if (clash) throw ApiError.conflict('Overlaps an existing {status} leave ({from} to {to})', { params: { status: clash.status, from: clash.from, to: clash.to } });
  await assertAvailable(ctx, emp, { type: data.type, year, days });
  const leave = await LeaveRequest.create({ ...data, days, year, society: ctx.societyId, employee: emp._id, user: emp.user._id || emp.user });
  // A manager filing on someone's behalf approves it in the same step.
  if (employeeId && isManagerRole(ctx.role)) return decide(ctx, leave._id, { approved: true, note: 'Recorded by manager' });
  const name = emp.user?.name || 'An employee';
  await notifyRoles(ctx.societyId, MANAGERS, { type: 'leave', title: `Leave request: ${name}`, body: `${days} day(s) ${data.type} · ${data.from}${data.to !== data.from ? ` to ${data.to}` : ''}`, link: '/staff/leave' });
  return LeaveRequest.findById(leave._id).populate(POPULATE).lean();
}

// Approval writes on_leave rows into attendance so the register and payroll see the leave.
async function writeAttendance(ctx, leave) {
  const emp = await Employee.findById(leave.employee).select('user').lean();
  const dates = dateRange(leave.from, leave.to);
  const existing = await Attendance.find({ society: ctx.societyId, employee: leave.employee, date: { $in: dates } }).select('date checkIn').lean();
  const worked = new Set(existing.filter((a) => a.checkIn?.at).map((a) => a.date));
  const paidLeave = PAID_LEAVE_TYPES.includes(leave.type);
  const ops = dates
    .filter((d) => !worked.has(d) || leave.halfDay) // a full day's leave never overwrites a day that was worked
    .map((date) => ({
      updateOne: {
        filter: { society: ctx.societyId, employee: leave.employee, date },
        update: leave.halfDay && worked.has(date)
          ? { $set: { leave: leave._id, paidLeave, leaveDays: 0.5 } }
          : { $set: { status: 'on_leave', leave: leave._id, paidLeave, leaveDays: leave.halfDay ? 0.5 : 1, autoMarked: false, markedBy: ctx.userId }, $setOnInsert: { user: emp.user } },
        upsert: true,
      },
    }));
  if (ops.length) await Attendance.bulkWrite(ops);
}

export async function decide(ctx, id, { approved, note }) {
  const leave = await LeaveRequest.findOne({ _id: id, society: ctx.societyId });
  if (!leave) throw ApiError.notFound('Leave request not found');
  if (leave.status !== 'pending') throw ApiError.conflict('This request is already {status}', { params: { status: leave.status } });
  if (approved) {
    const emp = await Employee.findById(leave.employee).lean();
    await assertAvailable(ctx, emp, leave, leave.days);
  }
  leave.set({ status: approved ? 'approved' : 'rejected', decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: note });
  await leave.save();
  if (approved) await writeAttendance(ctx, leave);
  await notifyUsers(ctx.societyId, [leave.user], {
    type: 'leave',
    title: `Leave ${approved ? 'approved' : 'rejected'}`,
    body: `${leave.type} · ${leave.from}${leave.to !== leave.from ? ` to ${leave.to}` : ''}${note ? ` · ${note}` : ''}`,
    link: '/my-work?tab=leave',
  });
  audit.record(ctx, `leave.${approved ? 'approved' : 'rejected'}`, 'LeaveRequest', leave._id, { days: leave.days, type: leave.type });
  invalidate(ctx.societyId, ['leave', 'attendance'], { roles: [] });
  return LeaveRequest.findById(leave._id).populate(POPULATE).lean();
}

export async function cancel(ctx, id) {
  const leave = await LeaveRequest.findOne({ _id: id, society: ctx.societyId });
  const own = leave && String(leave.user) === String(ctx.userId);
  if (!leave || (!own && !isManagerRole(ctx.role))) throw ApiError.notFound('Leave request not found');
  if (!['pending', 'approved'].includes(leave.status)) throw ApiError.conflict('This request is already {status}', { params: { status: leave.status } });
  if (leave.status === 'approved' && !isManagerRole(ctx.role) && leave.from <= today()) throw ApiError.conflict('Leave that has started can only be cancelled by a manager');
  const wasApproved = leave.status === 'approved';
  leave.status = 'cancelled';
  await leave.save();
  if (wasApproved) {
    // Undo the attendance rows the approval wrote; worked half-days keep their punches.
    await Attendance.deleteMany({ society: ctx.societyId, leave: leave._id, status: 'on_leave' });
    await Attendance.updateMany({ society: ctx.societyId, leave: leave._id }, { $unset: { leave: 1, paidLeave: 1, leaveDays: 1 } });
  }
  audit.record(ctx, 'leave.cancelled', 'LeaveRequest', leave._id);
  return LeaveRequest.findById(leave._id).populate(POPULATE).lean();
}

export async function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (!isManagerRole(ctx.role) || filters.mine) filter.user = ctx.userId;
  else if (filters.employee) filter.employee = filters.employee;
  if (filters.status) filter.status = filters.status;
  if (filters.year) filter.year = filters.year;
  return paginate(LeaveRequest, filter, pagination, { sort: { from: -1 }, populate: POPULATE });
}

export async function calendar(ctx, { period }) {
  const start = `${period}-01`;
  const end = `${period}-31`;
  const filter = { society: ctx.societyId, status: { $in: ['approved', 'pending'] }, from: { $lte: end }, to: { $gte: start } };
  if (!isManagerRole(ctx.role)) filter.user = ctx.userId;
  return LeaveRequest.find(filter).sort({ from: 1 }).populate(POPULATE).lean();
}

export async function setBalance(ctx, { employee, year, allocations, carriedForward }) {
  if (!(await Employee.exists({ _id: employee, society: ctx.societyId }))) throw ApiError.notFound('Employee not found');
  const $set = { updatedBy: ctx.userId };
  for (const [k, v] of Object.entries(allocations || {})) $set[`allocations.${k}`] = v;
  if (carriedForward !== undefined) $set.carriedForward = carriedForward;
  await LeaveBalance.updateOne({ society: ctx.societyId, employee, year }, { $set }, { upsert: true });
  audit.record(ctx, 'leave.balance_set', 'Employee', employee, { year, allocations, carriedForward });
  return { year, employee, balances: await balances(ctx, employee, year) };
}
