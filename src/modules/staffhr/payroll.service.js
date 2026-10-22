import PDFDocument from 'pdfkit';
import PayrollRun from './payrollRun.model.js';
import Payslip from './payslip.model.js';
import Employee from './employee.model.js';
import Attendance from './attendance.model.js';
import SalaryAdvance from './salaryAdvance.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { ROLES } from '../../common/constants/index.js';
import { nextSeq } from '../counter/counter.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { money } from '../../common/utils/money.js';
import { daysInPeriod, istInstant, today, workbookBuffer } from '../assets/facility.shared.js';
import { getSettings } from './employees.service.js';
import { totalsOf } from './attendance.service.js';

const PAYROLL_VIEWERS = [ROLES.ADMIN, ROLES.FACILITY_MANAGER, ROLES.ACCOUNTANT];
const canSeeAll = (ctx) => PAYROLL_VIEWERS.includes(ctx.role);
const sum = (lines) => lines.reduce((s, l) => s + l.amount, 0);

// ---------------------------------------------------------------- the calculation

// Pure payroll maths for one employee and month. All amounts integer paise.
//   LOP days = absent + ½·half-day + unpaid leave days + days outside employment.
//   Earnings are pro-rated by paid days / days in month. Days with no attendance record are paid.
//   PF = pf% of earned basic (capped at the PF wage ceiling); ESI = esi% of gross when the full
//   monthly gross is within the ESI ceiling; PT is a flat monthly amount.
export function computePayslip({ employee, period, records, settings, adjustments = [], advances = [] }) {
  const D = daysInPeriod(period);
  const first = `${period}-01`;
  const last = `${period}-${String(D).padStart(2, '0')}`;
  const s = employee.salary || {};
  const t = totalsOf(records);

  // Days before joining / after exit are not paid.
  let notEmployed = 0;
  for (let d = 1; d <= D; d += 1) {
    const date = `${period}-${String(d).padStart(2, '0')}`;
    if ((employee.dateOfJoining && date < employee.dateOfJoining) || (employee.dateOfExit && date > employee.dateOfExit)) notEmployed += 1;
  }
  const inEmployment = (r) => !(employee.dateOfJoining && r.date < employee.dateOfJoining) && !(employee.dateOfExit && r.date > employee.dateOfExit);
  const counted = totalsOf(records.filter(inEmployment));
  const lopDays = Math.min(D, counted.absent + counted.halfDay * 0.5 + counted.unpaidLeave + notEmployed);
  const paidDays = D - lopDays;
  const prorate = (amount) => Math.round(((amount || 0) * paidDays) / D);

  const earnings = [{ head: 'Basic', amount: prorate(s.basic) }];
  if (s.hra) earnings.push({ head: 'HRA', amount: prorate(s.hra) });
  for (const a of s.allowances || []) earnings.push({ head: a.name, amount: prorate(a.amount) });
  for (const a of adjustments.filter((x) => x.kind === 'earning')) earnings.push({ head: a.head, amount: a.amount });
  const gross = sum(earnings);

  const fullGross = (s.basic || 0) + (s.hra || 0) + sum(s.allowances || []);
  const deductionLines = [];
  const pf = Math.round((Math.min(earnings[0].amount, settings.pfWageCeiling ?? Infinity) * (s.pfPercent || 0)) / 100);
  if (pf) deductionLines.push({ head: 'Provident fund', amount: pf });
  const esi = fullGross <= (settings.esiWageCeiling ?? Infinity) ? Math.round((gross * (s.esiPercent || 0)) / 100) : 0;
  if (esi) deductionLines.push({ head: 'ESI', amount: esi });
  const pt = gross > 0 ? s.professionalTax || 0 : 0;
  if (pt) deductionLines.push({ head: 'Professional tax', amount: pt });
  for (const a of adjustments.filter((x) => x.kind === 'deduction')) deductionLines.push({ head: a.head, amount: a.amount });

  // Advance recovery never pushes net pay below zero.
  let room = gross - sum(deductionLines);
  const advanceRecoveries = [];
  for (const adv of advances) {
    const due = Math.min(adv.installment, adv.amount - adv.recovered, Math.max(0, room));
    if (due <= 0) continue;
    advanceRecoveries.push({ advance: adv._id, amount: due });
    deductionLines.push({ head: 'Salary advance', amount: due });
    room -= due;
  }
  const deductions = sum(deductionLines);
  return {
    period,
    daysInPeriod: D,
    paidDays,
    lopDays,
    attendance: { present: t.present, late: t.late, halfDay: t.halfDay, absent: t.absent, paidLeave: t.paidLeave, unpaidLeave: t.unpaidLeave, weekOff: t.weekOff, unmarked: D - records.length },
    earnings,
    deductionLines,
    advanceRecoveries,
    gross,
    deductions,
    net: gross - deductions,
    range: { first, last },
  };
}

// ---------------------------------------------------------------- runs

async function eligibleEmployees(ctx, period) {
  const first = `${period}-01`;
  const last = `${period}-${String(daysInPeriod(period)).padStart(2, '0')}`;
  return Employee.find({
    society: ctx.societyId,
    $and: [
      { $or: [{ dateOfJoining: null }, { dateOfJoining: { $lte: last } }] },
      { $or: [{ status: 'active' }, { dateOfExit: { $gte: first } }] },
    ],
  })
    .populate({ path: 'user', select: 'name' })
    .lean();
}

async function buildPayslip(ctx, run, employee, settings, existing) {
  const records = await Attendance.find({ society: ctx.societyId, employee: employee._id, date: { $gte: `${run.period}-01`, $lte: `${run.period}-31` } }).lean();
  const advances = await SalaryAdvance.find({ society: ctx.societyId, employee: employee._id, status: 'active', date: { $lte: `${run.period}-31` } }).sort({ date: 1 }).lean();
  const calc = computePayslip({ employee, period: run.period, records, settings, adjustments: existing?.adjustments || [], advances });
  const fields = {
    employeeCode: employee.employeeCode,
    name: employee.user?.name,
    designation: employee.designation,
    department: employee.department,
    bankLast4: employee.bank?.accountLast4,
    daysInPeriod: calc.daysInPeriod,
    paidDays: calc.paidDays,
    lopDays: calc.lopDays,
    attendance: calc.attendance,
    earnings: calc.earnings,
    deductionLines: calc.deductionLines,
    advanceRecoveries: calc.advanceRecoveries,
    gross: calc.gross,
    deductions: calc.deductions,
    net: calc.net,
  };
  if (existing) {
    existing.set(fields);
    return existing.save();
  }
  const seq = await nextSeq(ctx.societyId, `payslip:${run.period}`);
  return Payslip.create({ ...fields, society: ctx.societyId, run: run._id, employee: employee._id, user: employee.user._id, period: run.period, status: 'draft', number: `PS-${run.period}-${String(seq).padStart(4, '0')}` });
}

async function syncTotals(runId) {
  const [agg] = await Payslip.aggregate([
    { $match: { run: runId } },
    { $group: { _id: null, employees: { $sum: 1 }, gross: { $sum: '$gross' }, deductions: { $sum: '$deductions' }, net: { $sum: '$net' }, paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } } } },
  ]);
  const t = agg || { employees: 0, gross: 0, deductions: 0, net: 0, paidCount: 0 };
  const run = await PayrollRun.findByIdAndUpdate(runId, { employees: t.employees, gross: t.gross, deductions: t.deductions, net: t.net, paidCount: t.paidCount }, { returnDocument: 'after' });
  if (run.status === 'approved' && t.employees > 0 && t.paidCount === t.employees) {
    run.status = 'paid';
    await run.save();
  }
  return run;
}

export async function createRun(ctx, { period }) {
  if (period > today().slice(0, 7)) throw ApiError.badRequest('Payroll cannot be run for a future month');
  if (await PayrollRun.exists({ society: ctx.societyId, period })) throw ApiError.conflict('Payroll for {period} already exists', { params: { period } });
  const run = await PayrollRun.create({ society: ctx.societyId, period, createdBy: ctx.userId });
  await recomputeDraft(ctx, run);
  audit.record(ctx, 'payroll.run_created', 'PayrollRun', run._id, { period });
  return getRun(ctx, run._id);
}

async function recomputeDraft(ctx, run) {
  const settings = await getSettings(ctx);
  const employees = await eligibleEmployees(ctx, run.period);
  const existing = await Payslip.find({ run: run._id });
  const byEmp = new Map(existing.map((p) => [String(p.employee), p]));
  const keep = new Set();
  for (const e of employees) {
    keep.add(String(e._id));
    // eslint-disable-next-line no-await-in-loop
    await buildPayslip(ctx, run, e, settings, byEmp.get(String(e._id)));
  }
  const stale = existing.filter((p) => !keep.has(String(p.employee))).map((p) => p._id);
  if (stale.length) await Payslip.deleteMany({ _id: { $in: stale } });
  return syncTotals(run._id);
}

async function loadRun(ctx, id) {
  const run = await PayrollRun.findOne({ _id: id, society: ctx.societyId });
  if (!run) throw ApiError.notFound('Payroll run not found');
  return run;
}

export async function recompute(ctx, id) {
  const run = await loadRun(ctx, id);
  if (run.status !== 'draft') throw ApiError.conflict('Only draft payroll can be recalculated');
  await recomputeDraft(ctx, run);
  return getRun(ctx, run._id);
}

export async function discard(ctx, id) {
  const run = await loadRun(ctx, id);
  if (run.status !== 'draft') throw ApiError.conflict('Only draft payroll can be discarded');
  await Payslip.deleteMany({ run: run._id });
  await run.deleteOne();
  audit.record(ctx, 'payroll.run_discarded', 'PayrollRun', run._id, { period: run.period });
}

export const listRuns = (ctx, pagination) => paginate(PayrollRun, { society: ctx.societyId }, pagination, { sort: { period: -1 }, populate: { path: 'approvedBy', select: 'name' } });

export async function getRun(ctx, id) {
  const run = await PayrollRun.findOne({ _id: id, society: ctx.societyId }).populate([{ path: 'approvedBy', select: 'name' }, { path: 'createdBy', select: 'name' }]).lean();
  if (!run) throw ApiError.notFound('Payroll run not found');
  const payslips = await Payslip.find({ run: run._id }).sort({ employeeCode: 1 }).lean();
  return { ...run, payslips };
}

export async function approve(ctx, id) {
  const run = await loadRun(ctx, id);
  if (run.status !== 'draft') throw ApiError.conflict('Payroll is already {status}', { params: { status: run.status } });
  await recomputeDraft(ctx, run); // pick up the latest attendance and leave before freezing
  const payslips = await Payslip.find({ run: run._id }).lean();
  if (!payslips.length) throw ApiError.conflict('No employees in this payroll');
  // Advance recoveries become real only on approval.
  for (const p of payslips) {
    for (const r of p.advanceRecoveries || []) {
      // eslint-disable-next-line no-await-in-loop
      const adv = await SalaryAdvance.findOneAndUpdate(
        { _id: r.advance, society: ctx.societyId, status: 'active' },
        { $inc: { recovered: r.amount }, $push: { recoveries: { period: run.period, amount: r.amount, payslip: p._id } } },
        { returnDocument: 'after' },
      );
      // eslint-disable-next-line no-await-in-loop
      if (adv && adv.recovered >= adv.amount) await SalaryAdvance.updateOne({ _id: adv._id }, { status: 'closed' });
    }
  }
  await Payslip.updateMany({ run: run._id }, { status: 'approved' });
  run.set({ status: 'approved', approvedBy: ctx.userId, approvedAt: new Date() });
  await run.save();
  await syncTotals(run._id);
  for (const p of payslips) {
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers(ctx.societyId, [p.user], { type: 'payroll', title: `Payslip for ${run.period} is ready`, body: `Net pay ${money(p.net)}`, link: '/my-work?tab=payslips' });
  }
  audit.record(ctx, 'payroll.approved', 'PayrollRun', run._id, { period: run.period, net: payslips.reduce((s, p) => s + p.net, 0), employees: payslips.length });
  return getRun(ctx, run._id);
}

// ---------------------------------------------------------------- payslips

export function listPayslips(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (!canSeeAll(ctx)) {
    filter.user = ctx.userId;
    filter.status = { $in: ['approved', 'paid'] }; // drafts are still being worked on
  } else {
    if (filters.status) filter.status = filters.status;
    if (filters.employee) filter.employee = filters.employee;
    if (filters.run) filter.run = filters.run;
  }
  if (filters.period) filter.period = filters.period;
  return paginate(Payslip, filter, pagination, { sort: { period: -1, employeeCode: 1 } });
}

// Anyone except payroll staff sees only their own approved/paid payslips.
async function loadPayslip(ctx, id) {
  const p = await Payslip.findOne({ _id: id, society: ctx.societyId });
  const visible = p && (canSeeAll(ctx) || (String(p.user) === String(ctx.userId) && p.status !== 'draft'));
  if (!visible) throw ApiError.notFound('Payslip not found');
  return p;
}

export const getPayslip = async (ctx, id) => (await loadPayslip(ctx, id)).toObject();

export async function adjustPayslip(ctx, id, { adjustments }) {
  const p = await loadPayslip(ctx, id);
  if (p.status !== 'draft') throw ApiError.conflict('Only draft payslips can be adjusted');
  const run = await PayrollRun.findById(p.run);
  const employee = await Employee.findById(p.employee).populate({ path: 'user', select: 'name' }).lean();
  p.adjustments = adjustments;
  await buildPayslip(ctx, run, employee, await getSettings(ctx), p);
  await syncTotals(run._id);
  audit.record(ctx, 'payroll.payslip_adjusted', 'Payslip', p._id, { adjustments });
  return (await loadPayslip(ctx, id)).toObject();
}

export async function pay(ctx, id, { method, reference, paidAt }) {
  const p = await loadPayslip(ctx, id);
  if (p.status !== 'approved') throw ApiError.conflict(p.status === 'paid' ? 'Already paid' : 'Approve the payroll before paying');
  p.set({ status: 'paid', method, reference, paidAt: paidAt ? istInstant(paidAt, '12:00') : new Date(), paidBy: ctx.userId });
  await p.save();
  await syncTotals(p.run);
  await notifyUsers(ctx.societyId, [p.user], { type: 'payroll', title: `Salary for ${p.period} paid`, body: `${money(p.net)} via ${method}${reference ? ` · ${reference}` : ''}`, link: '/my-work?tab=payslips' });
  audit.record(ctx, 'payroll.payslip_paid', 'Payslip', p._id, { net: p.net, method, reference });
  return p.toObject();
}

export async function payRun(ctx, id, { method, reference, paidAt }) {
  const run = await loadRun(ctx, id);
  if (run.status !== 'approved') throw ApiError.conflict(run.status === 'paid' ? 'Already paid' : 'Approve the payroll first');
  const pending = await Payslip.find({ run: run._id, status: 'approved' }).select('_id').lean();
  for (const p of pending) {
    // eslint-disable-next-line no-await-in-loop
    await pay(ctx, p._id, { method, reference, paidAt });
  }
  return getRun(ctx, run._id);
}

export async function runXlsx(ctx, id) {
  const run = await getRun(ctx, id);
  const heads = [...new Set(run.payslips.flatMap((p) => p.earnings.map((e) => e.head)))];
  const dHeads = [...new Set(run.payslips.flatMap((p) => p.deductionLines.map((e) => e.head)))];
  const r = (v) => Math.round(v) / 100;
  return {
    filename: `payroll-${run.period}.xlsx`,
    buffer: await workbookBuffer([
      {
        name: `Payroll ${run.period}`,
        columns: [
          { header: 'Payslip', key: 'number', width: 18 },
          { header: 'Code', key: 'employeeCode', width: 10 },
          { header: 'Name', key: 'name', width: 24 },
          { header: 'Paid days', key: 'paidDays', width: 9 },
          { header: 'LOP days', key: 'lopDays', width: 9 },
          ...heads.map((h) => ({ header: `${h} (₹)`, key: `e_${h}`, width: 12 })),
          { header: 'Gross (₹)', key: 'gross', width: 12 },
          ...dHeads.map((h) => ({ header: `${h} (₹)`, key: `d_${h}`, width: 12 })),
          { header: 'Deductions (₹)', key: 'deductions', width: 13 },
          { header: 'Net (₹)', key: 'net', width: 12 },
          { header: 'Bank a/c', key: 'bank', width: 10 },
          { header: 'Status', key: 'status', width: 10 },
          { header: 'Reference', key: 'reference', width: 16 },
        ],
        rows: run.payslips.map((p) => ({
          ...p,
          ...Object.fromEntries(p.earnings.map((e) => [`e_${e.head}`, r(e.amount)])),
          ...Object.fromEntries(p.deductionLines.map((e) => [`d_${e.head}`, r(e.amount)])),
          gross: r(p.gross),
          deductions: r(p.deductions),
          net: r(p.net),
          bank: p.bankLast4 ? `••${p.bankLast4}` : '',
        })),
      },
    ]),
  };
}

// ---------------------------------------------------------------- PDF

const rs = (paise) => `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function payslipPdf(ctx, id) {
  const p = (await loadPayslip(ctx, id)).toObject();
  const society = await Society.findById(ctx.societyId).select('name address city state pincode').lean();
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Payslip ${p.number}` } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));

  const [y, m] = p.period.split('-').map(Number);
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  doc.fontSize(16).font('Helvetica-Bold').text(society?.name || 'Society', { align: 'center' });
  doc.fontSize(9).font('Helvetica').fillColor('#555').text([society?.address, society?.city, society?.state, society?.pincode].filter(Boolean).join(', '), { align: 'center' });
  doc.moveDown(0.5).fillColor('#000').fontSize(12).font('Helvetica-Bold').text(`Payslip for ${monthName}`, { align: 'center' });
  doc.moveDown();

  const info = [
    ['Employee', p.name || ''],
    ['Employee code', p.employeeCode || ''],
    ['Designation', p.designation || '-'],
    ['Payslip no.', p.number || ''],
    ['Days in month', String(p.daysInPeriod)],
    ['Paid days', String(p.paidDays)],
    ['Loss of pay days', String(p.lopDays)],
    ['Bank account', p.bankLast4 ? `XXXX${p.bankLast4}` : '-'],
  ];
  doc.fontSize(9).font('Helvetica');
  const top = doc.y;
  info.forEach(([k, v], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    doc.font('Helvetica-Bold').text(k, 48 + col * 250, top + row * 16, { width: 100 });
    doc.font('Helvetica').text(v, 150 + col * 250, top + row * 16, { width: 140 });
  });
  doc.y = top + Math.ceil(info.length / 2) * 16 + 12;

  const tableTop = doc.y;
  const rows = Math.max(p.earnings.length, p.deductionLines.length);
  doc.rect(48, tableTop, 499, 18).fill('#f1f5f9').fillColor('#000');
  doc.font('Helvetica-Bold').text('Earnings', 54, tableTop + 5).text('Amount', 200, tableTop + 5, { width: 90, align: 'right' });
  doc.text('Deductions', 304, tableTop + 5).text('Amount', 450, tableTop + 5, { width: 90, align: 'right' });
  doc.font('Helvetica');
  for (let i = 0; i < rows; i += 1) {
    const yy = tableTop + 24 + i * 16;
    const e = p.earnings[i];
    const d = p.deductionLines[i];
    if (e) doc.text(e.head, 54, yy, { width: 140 }).text(rs(e.amount), 200, yy, { width: 90, align: 'right' });
    if (d) doc.text(d.head, 304, yy, { width: 140 }).text(rs(d.amount), 450, yy, { width: 90, align: 'right' });
  }
  const totalY = tableTop + 28 + rows * 16;
  doc.moveTo(48, totalY - 4).lineTo(547, totalY - 4).strokeColor('#cbd5e1').stroke();
  doc.font('Helvetica-Bold').text('Gross earnings', 54, totalY).text(rs(p.gross), 200, totalY, { width: 90, align: 'right' });
  doc.text('Total deductions', 304, totalY).text(rs(p.deductions), 450, totalY, { width: 90, align: 'right' });
  doc.rect(48, totalY + 22, 499, 24).fill('#e0f2fe').fillColor('#000');
  doc.fontSize(11).text(`Net pay: ${rs(p.net)}`, 54, totalY + 29);

  doc.fontSize(9).font('Helvetica').moveDown(3);
  const a = p.attendance || {};
  doc.text(`Attendance: present ${a.present || 0} · late ${a.late || 0} · half day ${a.halfDay || 0} · absent ${a.absent || 0} · paid leave ${a.paidLeave || 0} · unpaid leave ${a.unpaidLeave || 0} · week off ${a.weekOff || 0}`, 48);
  if (p.status === 'paid') doc.moveDown(0.5).text(`Paid on ${new Date(p.paidAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })} via ${p.method}${p.reference ? ` (ref ${p.reference})` : ''}`);
  doc.moveDown(2).fillColor('#64748b').fontSize(8).text('This is a computer-generated payslip and does not need a signature.', { align: 'center' });
  doc.end();
  await done;
  return { filename: `payslip-${p.period}-${p.employeeCode}.pdf`, buffer: Buffer.concat(chunks) };
}

// ---------------------------------------------------------------- advances

export async function createAdvance(ctx, data) {
  const emp = await Employee.findOne({ _id: data.employee, society: ctx.societyId }).lean();
  if (!emp) throw ApiError.notFound('Employee not found');
  const adv = await SalaryAdvance.create({ ...data, date: data.date || today(), society: ctx.societyId, createdBy: ctx.userId });
  audit.record(ctx, 'payroll.advance_given', 'SalaryAdvance', adv._id, { employee: emp.employeeCode, amount: data.amount });
  return adv.toObject();
}

export function listAdvances(ctx, { employee, status }) {
  const filter = { society: ctx.societyId };
  if (employee) filter.employee = employee;
  if (status) filter.status = status;
  return SalaryAdvance.find(filter).sort({ date: -1 }).populate({ path: 'employee', select: 'employeeCode', populate: { path: 'user', select: 'name' } }).lean();
}
