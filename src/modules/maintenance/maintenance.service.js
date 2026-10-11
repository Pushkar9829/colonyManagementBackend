import PpmSchedule from './ppmSchedule.model.js';
import PpmTask from './ppmTask.model.js';
import Breakdown from './breakdown.model.js';
import Complaint from '../complaints/complaint.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { ROLES } from '../../common/constants/index.js';
import { nextNumber } from '../counter/counter.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import * as assets from '../assets/assets.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import { addDaysStr, addMonthsStr, assertMember, assignedFilter, canWorkOn, diffDays, isManagerRole, today } from '../assets/facility.shared.js';

const MANAGERS = [ROLES.ADMIN, ROLES.FACILITY_MANAGER];
const MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
const DAYS = { daily: 1, weekly: 7 };
const TASK_POPULATE = [
  { path: 'asset', select: 'name code category location' },
  { path: 'assignee', select: 'name' },
  { path: 'completedBy', select: 'name' },
];

// ---------------------------------------------------------------- occurrences

// Due dates of a schedule within [from, to]. Each occurrence is computed from the start date
// (not chained) so month-end clamping never drifts: Jan 31 → Feb 28 → Mar 31.
export function occurrences(schedule, from, to) {
  const out = [];
  const start = schedule.startDate;
  const last = schedule.endDate && schedule.endDate < to ? schedule.endDate : to;
  if (last < start) return out;
  const months = MONTHS[schedule.frequency];
  if (months) {
    let k = Math.max(0, Math.floor((diffDays(start, from) / 30.44 / months)) - 1);
    for (let guard = 0; guard < 1000; guard += 1, k += 1) {
      const d = addMonthsStr(start, k * months);
      if (d > last) break;
      if (d >= from) out.push(d);
    }
    return out;
  }
  const step = DAYS[schedule.frequency] || schedule.intervalDays || 1;
  let k = from > start ? Math.ceil(diffDays(start, from) / step) : 0;
  for (let d = addDaysStr(start, k * step); d <= last && out.length < 400; k += 1, d = addDaysStr(start, k * step)) out.push(d);
  return out;
}

// Creates the tasks of one schedule due between today and today + leadDays. Idempotent.
export async function generateForSchedule(schedule, now = new Date()) {
  if (!schedule.active) return 0;
  const t = today(now);
  const dates = occurrences(schedule, t, addDaysStr(t, schedule.leadDays ?? 7));
  if (!dates.length) return 0;
  const res = await PpmTask.bulkWrite(
    dates.map((dueDate) => ({
      updateOne: {
        filter: { schedule: schedule._id, dueDate },
        update: {
          $setOnInsert: {
            society: schedule.society,
            schedule: schedule._id,
            asset: schedule.asset,
            title: schedule.title,
            dueDate,
            missAfter: addDaysStr(dueDate, schedule.graceDays ?? 3),
            status: 'pending',
            assigneeRole: schedule.assigneeRole,
            assignee: schedule.assignee || undefined,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return res.upsertedCount;
}

// ---------------------------------------------------------------- schedules

async function loadSchedule(ctx, id) {
  const s = await PpmSchedule.findOne({ _id: id, society: ctx.societyId });
  if (!s) throw ApiError.notFound('Schedule not found');
  return s;
}

export async function createSchedule(ctx, data) {
  await assets.findForSociety(ctx, data.asset);
  await assertMember(ctx, data.assignee);
  const schedule = await PpmSchedule.create({ ...data, society: ctx.societyId, createdBy: ctx.userId });
  const created = await generateForSchedule(schedule);
  audit.record(ctx, 'ppm.schedule_created', 'PpmSchedule', schedule._id, { title: schedule.title, frequency: schedule.frequency });
  return { ...(await PpmSchedule.findById(schedule._id).populate([{ path: 'asset', select: 'name code' }, { path: 'assignee', select: 'name' }]).lean()), tasksCreated: created };
}

export const listSchedules = (ctx, filters, pagination) => {
  const filter = { society: ctx.societyId };
  if (filters.asset) filter.asset = filters.asset;
  if (filters.active !== undefined) filter.active = filters.active;
  return paginate(PpmSchedule, filter, pagination, { populate: [{ path: 'asset', select: 'name code category' }, { path: 'assignee', select: 'name' }] });
};

const RESCHEDULE_FIELDS = ['frequency', 'intervalDays', 'startDate', 'endDate', 'assignee', 'assigneeRole', 'title', 'graceDays', 'active'];

export async function updateSchedule(ctx, id, data) {
  const schedule = await loadSchedule(ctx, id);
  if (data.assignee) await assertMember(ctx, data.assignee);
  for (const [k, v] of Object.entries(data)) schedule.set(k, v === null ? undefined : v);
  await schedule.save();
  // Untouched future occurrences are rebuilt so they follow the new plan; started/completed ones stay.
  if (RESCHEDULE_FIELDS.some((f) => f in data)) {
    await PpmTask.deleteMany({ schedule: schedule._id, status: 'pending', dueDate: { $gte: today() } });
    await generateForSchedule(schedule);
  }
  audit.record(ctx, 'ppm.schedule_updated', 'PpmSchedule', schedule._id, { fields: Object.keys(data) });
  return PpmSchedule.findById(schedule._id).populate([{ path: 'asset', select: 'name code' }, { path: 'assignee', select: 'name' }]).lean();
}

export async function getSchedule(ctx, id) {
  const s = await PpmSchedule.findOne({ _id: id, society: ctx.societyId }).populate([{ path: 'asset', select: 'name code' }, { path: 'assignee', select: 'name' }]).lean();
  if (!s) throw ApiError.notFound('Schedule not found');
  return s;
}

// ---------------------------------------------------------------- tasks

function taskFilter(ctx, filters = {}) {
  const filter = { society: ctx.societyId, ...assignedFilter(ctx) };
  if (filters.mine && isManagerRole(ctx.role)) filter.assignee = ctx.userId;
  if (filters.status) filter.status = filters.status;
  if (filters.open) filter.status = { $in: ['pending', 'overdue'] };
  if (filters.asset) filter.asset = filters.asset;
  if (filters.schedule) filter.schedule = filters.schedule;
  if (filters.date) filter.dueDate = filters.date;
  if (filters.from || filters.to) filter.dueDate = { ...(filters.from && { $gte: filters.from }), ...(filters.to && { $lte: filters.to }) };
  return filter;
}

export const listTasks = (ctx, filters, pagination) =>
  paginate(PpmTask, taskFilter(ctx, filters), pagination, { sort: { dueDate: 1, createdAt: 1 }, populate: TASK_POPULATE, select: '-results' });

async function loadTask(ctx, id) {
  const task = await PpmTask.findOne({ _id: id, society: ctx.societyId });
  if (!task || !canWorkOn(ctx, task)) throw ApiError.notFound('Task not found');
  return task;
}

export async function getTask(ctx, id) {
  const task = await loadTask(ctx, id);
  const schedule = await PpmSchedule.findById(task.schedule).select('checklist description frequency').lean();
  const doc = await PpmTask.findById(task._id).populate([...TASK_POPULATE, { path: 'breakdown', select: 'number status' }]).lean();
  return { ...doc, checklist: schedule?.checklist || [], description: schedule?.description, frequency: schedule?.frequency };
}

// Validates checklist answers against the schedule's items and flags failures.
function evaluate(checklist, answers) {
  const byId = new Map(answers.map((a) => [String(a.itemId), a.value]));
  const results = [];
  const missing = [];
  for (const item of checklist) {
    const raw = byId.get(String(item._id));
    const empty = raw === undefined || raw === null || raw === '';
    if (empty) {
      if (item.required) missing.push(item.label);
      continue;
    }
    let value = raw;
    let ok = true;
    if (item.type === 'yes_no') {
      if (typeof raw !== 'boolean') throw ApiError.badRequest(`"${item.label}" needs a yes / no answer`);
      ok = raw;
    } else if (item.type === 'reading') {
      value = Number(raw);
      if (!Number.isFinite(value)) throw ApiError.badRequest(`"${item.label}" needs a number`);
      ok = (item.min === undefined || item.min === null || value >= item.min) && (item.max === undefined || item.max === null || value <= item.max);
    } else value = String(raw);
    results.push({ itemId: item._id, label: item.label, type: item.type, unit: item.unit, min: item.min, max: item.max, value, ok });
  }
  if (missing.length) throw ApiError.badRequest(`Answer the required items: ${missing.join(', ')}`);
  return results;
}

const EARLY_DAYS = 3; // tasks can be done a little ahead of the due date, not weeks ahead

export async function completeTask(ctx, id, { results: answers, photos: photoIds, remarks, raiseBreakdown }) {
  const task = await loadTask(ctx, id);
  if (!['pending', 'overdue'].includes(task.status)) throw ApiError.conflict(`This task is ${task.status}`);
  const t = today();
  if (diffDays(t, task.dueDate) > EARLY_DAYS) throw ApiError.conflict(`This task is due on ${task.dueDate}; it can be done at most ${EARLY_DAYS} days early`);
  const schedule = await PpmSchedule.findById(task.schedule).select('checklist').lean();
  const results = evaluate(schedule?.checklist || [], answers);
  const photos = await uploads.resolve(ctx, photoIds);

  task.set({ results, photos, remarks, status: 'completed', completedBy: ctx.userId, completedAt: new Date(), late: t > task.dueDate, hasIssues: results.some((r) => !r.ok) });
  await task.save();
  const failed = results.filter((r) => !r.ok).map((r) => r.label);
  await assets.recordEvent(ctx, task.asset, {
    type: 'ppm_completed',
    title: `PPM done: ${task.title}`,
    notes: [failed.length ? `Issues: ${failed.join(', ')}` : 'All checks OK', remarks].filter(Boolean).join(' · '),
    date: t,
    attachments: photos,
    ref: { kind: 'PpmTask', id: task._id },
  });
  if (raiseBreakdown) {
    const b = await createBreakdown(ctx, { asset: String(task.asset), title: raiseBreakdown.title, priority: raiseBreakdown.priority, description: remarks, ppmTask: String(task._id), markUnderRepair: true });
    task.breakdown = b._id;
    await task.save();
  } else if (failed.length) {
    await notifyRoles(ctx.societyId, MANAGERS, { type: 'facility', title: `PPM issues: ${task.title}`, body: failed.join(', '), link: `/maintenance?task=${task._id}` });
  }
  invalidate(ctx.societyId, ['ppm'], { roles: ['staff'] });
  return getTask(ctx, task._id);
}

export async function skipTask(ctx, id, { reason }) {
  const task = await loadTask(ctx, id);
  if (!['pending', 'overdue'].includes(task.status)) throw ApiError.conflict(`This task is ${task.status}`);
  task.set({ status: 'skipped', skipReason: reason });
  await task.save();
  audit.record(ctx, 'ppm.task_skipped', 'PpmTask', task._id, { reason });
  return getTask(ctx, task._id);
}

export async function reassignTask(ctx, id, { assignee, assigneeRole }) {
  const task = await loadTask(ctx, id);
  if (!['pending', 'overdue'].includes(task.status)) throw ApiError.conflict(`This task is ${task.status}`);
  if (assignee) await assertMember(ctx, assignee);
  task.assignee = assignee || undefined;
  if (assigneeRole) task.assigneeRole = assigneeRole;
  await task.save();
  if (assignee) await notifyUsers(ctx.societyId, [assignee], { type: 'facility', title: `PPM task assigned: ${task.title}`, body: `Due ${task.dueDate}`, link: '/my-work' });
  return getTask(ctx, task._id);
}

// Pending tasks past due → overdue (notify once); overdue beyond grace → missed.
export async function sweepOverdue(now = new Date()) {
  const t = today(now);
  const due = await PpmTask.find({ status: 'pending', dueDate: { $lt: t } }).select('society title dueDate assignee assigneeRole').limit(5000).lean();
  if (due.length) await PpmTask.updateMany({ _id: { $in: due.map((x) => x._id) } }, { status: 'overdue', overdueNotifiedAt: now });
  const bySociety = new Map();
  for (const task of due) {
    if (!bySociety.has(String(task.society))) bySociety.set(String(task.society), []);
    bySociety.get(String(task.society)).push(task);
    if (task.assignee) {
      // eslint-disable-next-line no-await-in-loop
      await notifyUsers(task.society, [task.assignee], { type: 'facility', title: `Overdue: ${task.title}`, body: `Was due on ${task.dueDate}`, link: '/my-work' });
    }
  }
  for (const [society, tasks] of bySociety) {
    // eslint-disable-next-line no-await-in-loop
    await notifyRoles(society, MANAGERS, {
      type: 'facility',
      title: `${tasks.length} PPM task(s) overdue`,
      body: tasks.slice(0, 3).map((x) => x.title).join(', '),
      link: '/maintenance?status=overdue',
    });
  }

  const missed = await PpmTask.find({ status: 'overdue', missAfter: { $lt: t } }).select('society asset title dueDate').limit(5000).lean();
  if (missed.length) {
    await PpmTask.updateMany({ _id: { $in: missed.map((x) => x._id) } }, { status: 'missed' });
    for (const m of missed) {
      // eslint-disable-next-line no-await-in-loop
      await assets.recordEvent({ societyId: m.society, userId: null }, m.asset, { type: 'ppm_missed', title: `PPM missed: ${m.title}`, notes: `Due ${m.dueDate}`, ref: { kind: 'PpmTask', id: m._id } });
    }
  }
  return { overdue: due.length, missed: missed.length };
}

// Completion rate per schedule for tasks due in the range (default: last 30 days).
export async function ppmReport(ctx, { from, to }) {
  const t = today();
  const end = to && to < t ? to : t;
  const start = from || addDaysStr(end, -29);
  const rows = await PpmTask.aggregate([
    { $match: { society: ctx.societyId, dueDate: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: '$schedule',
        asset: { $first: '$asset' },
        title: { $first: '$title' },
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        late: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, '$late'] }, 1, 0] } },
        missed: { $sum: { $cond: [{ $eq: ['$status', 'missed'] }, 1, 0] } },
        overdue: { $sum: { $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
        skipped: { $sum: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] } },
        issues: { $sum: { $cond: ['$hasIssues', 1, 0] } },
      },
    },
    { $lookup: { from: 'assets', localField: 'asset', foreignField: '_id', as: 'asset', pipeline: [{ $project: { name: 1, code: 1 } }] } },
    { $unwind: { path: '$asset', preserveNullAndEmptyArrays: true } },
    { $sort: { title: 1 } },
  ]);
  const rate = (r) => {
    const counted = r.total - r.skipped - r.pending;
    return counted > 0 ? Math.round((r.completed / counted) * 1000) / 10 : null;
  };
  const totals = rows.reduce(
    (acc, r) => ({ total: acc.total + r.total, completed: acc.completed + r.completed, late: acc.late + r.late, missed: acc.missed + r.missed, overdue: acc.overdue + r.overdue, pending: acc.pending + r.pending, skipped: acc.skipped + r.skipped, issues: acc.issues + r.issues }),
    { total: 0, completed: 0, late: 0, missed: 0, overdue: 0, pending: 0, skipped: 0, issues: 0 },
  );
  return {
    from: start,
    to: end,
    totals: { ...totals, onTime: totals.completed - totals.late, completionRate: rate(totals) },
    rows: rows.map((r) => ({ ...r, schedule: r._id, _id: undefined, onTime: r.completed - r.late, completionRate: rate(r) })),
  };
}

export async function ppmStats(ctx) {
  const t = today();
  const base = { society: ctx.societyId, ...assignedFilter(ctx) };
  const [dueToday, overdue, completedToday, openBreakdowns] = await Promise.all([
    PpmTask.countDocuments({ ...base, dueDate: t, status: 'pending' }),
    PpmTask.countDocuments({ ...base, status: 'overdue' }),
    PpmTask.countDocuments({ ...base, status: 'completed', completedAt: { $gte: new Date(`${t}T00:00:00+05:30`) } }),
    Breakdown.countDocuments({ society: ctx.societyId, status: { $in: ['open', 'in_progress'] } }),
  ]);
  return { dueToday, overdue, completedToday, openBreakdowns };
}

// ---------------------------------------------------------------- breakdowns

const BD_POPULATE = [
  { path: 'asset', select: 'name code category location status' },
  { path: 'reportedBy', select: 'name' },
  { path: 'assignedTo', select: 'name' },
  { path: 'complaint', select: 'ticketNumber title status' },
  { path: 'workOrder', select: 'number status' },
];

async function loadBreakdown(ctx, id) {
  const filter = { _id: id, society: ctx.societyId };
  if (!isManagerRole(ctx.role)) filter.$or = [{ assignedTo: ctx.userId }, { reportedBy: ctx.userId }];
  const b = await Breakdown.findOne(filter);
  if (!b) throw ApiError.notFound('Breakdown not found');
  return b;
}

export async function createBreakdown(ctx, { markUnderRepair, attachments: ids, ...data }) {
  const asset = await assets.findForSociety(ctx, data.asset);
  if (data.complaint && !(await Complaint.exists({ _id: data.complaint, society: ctx.societyId }))) throw ApiError.badRequest('Complaint not found in this society');
  if (data.ppmTask && !(await PpmTask.exists({ _id: data.ppmTask, society: ctx.societyId }))) throw ApiError.badRequest('PPM task not found');
  if (data.assignedTo) await assertMember(ctx, data.assignedTo);
  const attachments = await uploads.resolve(ctx, ids);
  const b = await Breakdown.create({ ...data, attachments, society: ctx.societyId, number: await nextNumber(ctx.societyId, 'breakdown', 'BRK'), reportedBy: ctx.userId });
  await assets.recordEvent(ctx, asset._id, { type: 'breakdown_reported', title: `Breakdown ${b.number}: ${b.title}`, notes: data.description, attachments, ref: { kind: 'Breakdown', id: b._id } });
  if (markUnderRepair) await assets.setStatusQuietly(ctx, asset._id, 'under_repair', `Under repair (${b.number})`);
  await notifyRoles(ctx.societyId, MANAGERS, { type: 'facility', title: `Breakdown: ${asset.name}`, body: `${b.number} · ${b.title}`, link: `/maintenance?tab=breakdowns&id=${b._id}`, channels: ['inapp', 'push'] });
  if (data.assignedTo) await notifyUsers(ctx.societyId, [data.assignedTo], { type: 'facility', title: `Breakdown assigned: ${asset.name}`, body: b.title, link: '/my-work' });
  audit.record(ctx, 'breakdown.reported', 'Breakdown', b._id, { number: b.number, asset: asset.code });
  return Breakdown.findById(b._id).populate(BD_POPULATE).lean();
}

export function listBreakdowns(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (!isManagerRole(ctx.role)) filter.$or = [{ assignedTo: ctx.userId }, { reportedBy: ctx.userId }];
  if (filters.status) filter.status = filters.status;
  if (filters.open) filter.status = { $in: ['open', 'in_progress'] };
  if (filters.asset) filter.asset = filters.asset;
  return paginate(Breakdown, filter, pagination, { populate: BD_POPULATE });
}

export async function getBreakdown(ctx, id) {
  const b = await loadBreakdown(ctx, id);
  return Breakdown.findById(b._id).populate(BD_POPULATE).lean();
}

export async function assignBreakdown(ctx, id, { assignedTo }) {
  const b = await loadBreakdown(ctx, id);
  await assertMember(ctx, assignedTo);
  b.assignedTo = assignedTo;
  if (b.status === 'open') b.status = 'in_progress';
  await b.save();
  await notifyUsers(ctx.societyId, [assignedTo], { type: 'facility', title: `Breakdown assigned: ${b.number}`, body: b.title, link: '/my-work' });
  return getBreakdown(ctx, b._id);
}

const BD_FLOW = { open: ['in_progress', 'resolved'], in_progress: ['resolved'], resolved: ['closed', 'in_progress'], closed: [] };

export async function changeBreakdownStatus(ctx, id, { status, resolution, cost, attachments: ids }) {
  const b = await loadBreakdown(ctx, id);
  if (!BD_FLOW[b.status].includes(status)) throw ApiError.conflict(`Cannot move from ${b.status} to ${status}`);
  if (status === 'closed' && !isManagerRole(ctx.role)) throw ApiError.forbidden('Only managers can close breakdowns');
  if (status === 'resolved' && !resolution) throw ApiError.badRequest('Describe the resolution');
  const attachments = await uploads.resolve(ctx, ids);
  b.status = status;
  if (status === 'resolved') {
    b.set({ resolution, cost, resolvedAt: new Date(), resolvedBy: ctx.userId });
    b.attachments.push(...attachments);
  }
  if (status === 'closed') b.closedAt = new Date();
  await b.save();
  if (status === 'resolved') {
    await assets.recordEvent(ctx, b.asset, { type: 'breakdown_resolved', title: `Breakdown ${b.number} resolved`, notes: resolution, cost, attachments, ref: { kind: 'Breakdown', id: b._id } });
    const stillOpen = await Breakdown.exists({ society: ctx.societyId, asset: b.asset, status: { $in: ['open', 'in_progress'] } });
    if (!stillOpen) await assets.setStatusQuietly(ctx, b.asset, 'working', `Back in service (${b.number})`);
    await notifyRoles(ctx.societyId, MANAGERS, { type: 'facility', title: `Breakdown ${b.number} resolved`, body: resolution, link: `/maintenance?tab=breakdowns&id=${b._id}` });
  }
  return getBreakdown(ctx, b._id);
}

// Lets work orders link back to their breakdown.
export async function linkWorkOrder(ctx, breakdownId, workOrderId) {
  await Breakdown.updateOne({ _id: breakdownId, society: ctx.societyId }, { workOrder: workOrderId });
}

export const findTask = (ctx, id) => PpmTask.findOne({ _id: id, society: ctx.societyId }).select('asset title').lean();
export const findBreakdown = (ctx, id) => Breakdown.findOne({ _id: id, society: ctx.societyId }).select('asset title number').lean();
