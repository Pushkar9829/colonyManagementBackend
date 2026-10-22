import mongoose from 'mongoose';
import ReportSchedule from './reportSchedule.model.js';
import { REPORTS, reportByKey } from './reports.definitions.js';
import { FORMATS, xlsxBuffer } from './writers.js';
import Society from '../society/society.model.js';
import Bill from '../billing/bill.model.js';
import Payment from '../payments/payment.model.js';
import Complaint from '../complaints/complaint.model.js';
import Visitor from '../visitors/visitor.model.js';
import { societyAdminEmails } from '../subscriptions/platformMail.js';
import * as audit from '../audit/audit.service.js';
import { email } from '../../integrations/email.js';
import ApiError from '../../common/errors/ApiError.js';
import { addDays, localDateString, startOfLocalDay } from '../../common/utils/dates.js';
import { money } from '../../common/utils/money.js';
import logger from '../../common/utils/logger.js';

const DEFAULT_RANGE_DAYS = 30;
const ACTIVE_COMPLAINT = ['open', 'assigned', 'in_progress', 'on_hold', 'reopened'];
const SHEET_ROWS = 5000; // per sheet in emailed workbooks; the full data is in the reports center

const istStart = (ymd) => new Date(`${ymd}T00:00:00+05:30`);
const nextDay = (ymd) => addDays(istStart(ymd), 1);

export function catalogue(ctx) {
  return REPORTS.filter((r) => r.roles.includes(ctx.role)).map(({ key, label, description, params, columns }) => ({ key, label, description, params, columns: columns.map((c) => c.header), formats: Object.keys(FORMATS) }));
}

function loadReport(ctx, key) {
  const report = reportByKey(key);
  if (!report) throw ApiError.notFound('Unknown report');
  if (!report.roles.includes(ctx.role)) throw ApiError.forbidden('You cannot run this report');
  return report;
}

// Calendar range in IST. Reports with a date range default to the last 30 days.
function params(report, q) {
  const p = { status: q.status, period: q.period };
  if (report.params.includes('from')) {
    const toYmd = q.to || localDateString();
    const fromYmd = q.from || localDateString(addDays(istStart(toYmd), -(DEFAULT_RANGE_DAYS - 1)));
    if (fromYmd > toYmd) throw ApiError.badRequest('"from" must be on or before "to"');
    Object.assign(p, { from: istStart(fromYmd), to: nextDay(toYmd), fromDate: fromYmd, toDate: toYmd });
  }
  return p;
}

function subtitleFor(report, society, p) {
  const bits = [society?.name];
  if (p.fromDate) bits.push(`${p.fromDate} to ${p.toDate}`);
  if (p.period) bits.push(p.period);
  if (p.status) bits.push(p.status);
  bits.push(`generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
  return bits.filter(Boolean).join(' · ');
}

// Everything the controller needs to stream one export.
export async function prepare(ctx, key, q) {
  const report = loadReport(ctx, key);
  const format = FORMATS[q.format || 'csv'];
  const p = params(report, q);
  const society = await Society.findById(ctx.societyId).select('name code').lean();
  const stamp = p.fromDate ? `${p.fromDate}_${p.toDate}` : p.period || localDateString();
  audit.record(ctx, 'report.exported', 'Report', null, { report: key, format: format.ext, ...(p.fromDate ? { from: p.fromDate, to: p.toDate } : {}), ...(p.period ? { period: p.period } : {}) });
  return {
    report,
    format,
    rows: report.rows(ctx, p),
    filename: `${society?.code || 'society'}-${key}-${stamp}.${format.ext}`,
    title: `${report.label} - ${society?.name || ''}`,
    subtitle: subtitleFor(report, society, p),
  };
}

// ---------- summary emails ----------
async function collect(gen, max = SHEET_ROWS) {
  const out = [];
  for await (const row of gen) {
    if (out.length >= max) break;
    out.push(row);
  }
  return out;
}

export function summaryRange(frequency, now = new Date()) {
  const today = localDateString(now);
  if (frequency === 'weekly') return { from: addDays(istStart(today), -7), to: istStart(today), label: 'last 7 days' };
  const [y, m] = today.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return { from: istStart(`${prev}-01`), to: istStart(`${today.slice(0, 7)}-01`), label: prev, period: prev };
}

// Next send time: Mondays (weekly) or the 1st (monthly), at 08:00 IST.
export function nextRunAt(frequency, after = new Date()) {
  if (frequency === 'weekly') {
    let day = startOfLocalDay(after);
    for (let i = 0; i < 8; i += 1) {
      const at = new Date(day.getTime() + 8 * 3600000);
      if (new Date(`${localDateString(day)}T12:00:00+05:30`).getUTCDay() === 1 && at > after) return at;
      day = addDays(day, 1);
    }
  }
  const today = localDateString(after);
  const firstThis = new Date(`${today.slice(0, 7)}-01T08:00:00+05:30`);
  if (firstThis > after) return firstThis;
  const [y, m] = today.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return new Date(`${next}-01T08:00:00+05:30`);
}

const sum = async (model, match, field) => (await model.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: field }, n: { $sum: 1 } } }]))[0] || { total: 0, n: 0 };

export async function buildSummary(societyId, range, sections) {
  const s = new mongoose.Types.ObjectId(String(societyId));
  const ctx = { societyId: s, role: 'admin' };
  const p = { from: range.from, to: range.to, fromDate: localDateString(range.from), toDate: localDateString(addDays(range.to, -1)) };
  const lines = [];
  const sheets = [];
  const data = {};
  const now = new Date();

  if (sections.includes('collections')) {
    const [collected, billed] = await Promise.all([
      sum(Payment, { society: s, status: 'success', paidAt: { $gte: range.from, $lt: range.to } }, '$amount'),
      sum(Bill, { society: s, status: { $ne: 'cancelled' }, createdAt: { $gte: range.from, $lt: range.to } }, '$total'),
    ]);
    data.collections = { collected: collected.total, payments: collected.n, billed: billed.total, bills: billed.n };
    lines.push(`Collections: ${money(collected.total)} from ${collected.n} payments (billed ${money(billed.total)} in ${billed.n} bills).`);
    sheets.push({ report: reportByKey('payments'), rows: await collect(reportByKey('payments').rows(ctx, p)) });
  }
  if (sections.includes('dues')) {
    const [outstanding, overdue] = await Promise.all([
      sum(Bill, { society: s, status: { $in: ['unpaid', 'partial'] } }, { $subtract: ['$total', '$paid'] }),
      sum(Bill, { society: s, status: { $in: ['unpaid', 'partial'] }, dueDate: { $lt: now } }, { $subtract: ['$total', '$paid'] }),
    ]);
    const defaulters = await collect(reportByKey('defaulters').rows(ctx, p));
    data.dues = { outstanding: outstanding.total, overdue: overdue.total, defaulterUnits: defaulters.length };
    lines.push(`Dues: ${money(outstanding.total)} outstanding, ${money(overdue.total)} overdue across ${defaulters.length} units.`);
    sheets.push({ report: reportByKey('defaulters'), rows: defaulters });
  }
  if (sections.includes('complaints')) {
    const [opened, resolved, open, breached] = await Promise.all([
      Complaint.countDocuments({ society: s, createdAt: { $gte: range.from, $lt: range.to } }),
      Complaint.countDocuments({ society: s, resolvedAt: { $gte: range.from, $lt: range.to } }),
      Complaint.countDocuments({ society: s, status: { $in: ACTIVE_COMPLAINT } }),
      Complaint.countDocuments({ society: s, status: { $in: ACTIVE_COMPLAINT }, slaDueAt: { $lt: now } }),
    ]);
    data.complaints = { opened, resolved, open, breached };
    lines.push(`Complaints: ${opened} raised, ${resolved} resolved; ${open} open now (${breached} past SLA).`);
    sheets.push({ report: reportByKey('complaints'), rows: await collect(reportByKey('complaints').rows(ctx, p)) });
  }
  if (sections.includes('visitors')) {
    const byDay = await Visitor.aggregate([
      { $match: { society: s, createdAt: { $gte: range.from, $lt: range.to } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } }, total: { $sum: 1 }, deliveries: { $sum: { $cond: [{ $eq: ['$purpose', 'delivery'] }, 1, 0] } } } },
      { $sort: { _id: 1 } },
    ]);
    const total = byDay.reduce((t, d) => t + d.total, 0);
    data.visitors = { total, days: byDay.length };
    lines.push(`Visitors: ${total} at the gate.`);
    sheets.push({
      report: { label: 'Visitors by day', columns: [{ key: 'date', header: 'Date', width: 12 }, { key: 'total', header: 'Visitors', width: 10 }, { key: 'deliveries', header: 'Deliveries', width: 10 }] },
      rows: byDay.map((d) => ({ date: d._id, total: d.total, deliveries: d.deliveries })),
    });
  }
  return { data, lines, sheets };
}

async function deliver(schedule, now) {
  const society = await Society.findById(schedule.society).select('name code active').lean();
  const range = summaryRange(schedule.frequency, now);
  const { lines, sheets, data } = await buildSummary(schedule.society, range, schedule.sections);
  const to = schedule.recipients.length ? schedule.recipients : await societyAdminEmails(schedule.society);
  if (!to.length) throw new Error('No recipients: add an email address or give an admin an email');
  const subject = `${society.name}: ${schedule.frequency} summary (${range.label})`;
  await email.send({
    to,
    subject,
    text: `${subject}\n\n${lines.join('\n')}\n\nThe attached Excel file has the details. Full reports: ColonyHub > Reports.\n`,
    attachments: [{ filename: `${society.code}-${schedule.frequency}-summary-${localDateString(range.from)}.xlsx`, content: await xlsxBuffer(sheets), type: FORMATS.xlsx.contentType }],
  });
  return { to, data };
}

// ---------- schedules CRUD ----------
export const listSchedules = (ctx) => ReportSchedule.find({ society: ctx.societyId }).sort({ frequency: 1 }).lean();

export async function createSchedule(ctx, data) {
  if (await ReportSchedule.exists({ society: ctx.societyId, frequency: data.frequency })) throw ApiError.conflict('A {frequency} summary is already set up', { params: { frequency: data.frequency } });
  const doc = await ReportSchedule.create({ ...data, society: ctx.societyId, createdBy: ctx.userId, nextRunAt: nextRunAt(data.frequency) });
  audit.record(ctx, 'report.schedule_created', 'ReportSchedule', doc._id, data);
  return doc.toObject();
}

async function loadSchedule(ctx, id) {
  const doc = await ReportSchedule.findOne({ _id: id, society: ctx.societyId });
  if (!doc) throw ApiError.notFound('Schedule not found');
  return doc;
}

export async function updateSchedule(ctx, id, data) {
  const doc = await loadSchedule(ctx, id);
  Object.assign(doc, data);
  if (data.enabled) doc.nextRunAt = nextRunAt(doc.frequency);
  await doc.save();
  audit.record(ctx, 'report.schedule_updated', 'ReportSchedule', doc._id, data);
  return doc.toObject();
}

export async function removeSchedule(ctx, id) {
  const doc = await loadSchedule(ctx, id);
  await doc.deleteOne();
  audit.record(ctx, 'report.schedule_deleted', 'ReportSchedule', doc._id, { frequency: doc.frequency });
}

export async function sendNow(ctx, id) {
  const doc = await loadSchedule(ctx, id);
  try {
    const { to, data } = await deliver(doc, new Date());
    doc.lastSentAt = new Date();
    doc.lastError = undefined;
    await doc.save();
    return { sentTo: to, summary: data };
  } catch (err) {
    doc.lastError = err.message;
    await doc.save();
    throw ApiError.badRequest(err.message);
  }
}

export async function preview(ctx, frequency) {
  const range = summaryRange(frequency);
  const { data, lines } = await buildSummary(ctx.societyId, range, ['collections', 'dues', 'complaints', 'visitors']);
  return { range: { from: range.from, to: range.to, label: range.label }, data, lines };
}

// ---------- scheduled ----------
export async function runScheduled(now = new Date()) {
  const due = await ReportSchedule.find({ enabled: true, nextRunAt: { $lte: now } }).limit(200);
  let sent = 0;
  let failed = 0;
  for (const schedule of due) {
    // eslint-disable-next-line no-await-in-loop
    const society = await Society.findById(schedule.society).select('active').lean();
    try {
      // eslint-disable-next-line no-await-in-loop
      if (society?.active) await deliver(schedule, now);
      schedule.lastSentAt = society?.active ? now : schedule.lastSentAt;
      schedule.lastError = society?.active ? undefined : 'Society is suspended';
      sent += society?.active ? 1 : 0;
    } catch (err) {
      failed += 1;
      schedule.lastError = err.message;
      logger.warn({ err: err.message, schedule: String(schedule._id) }, 'scheduled report failed');
    }
    schedule.nextRunAt = nextRunAt(schedule.frequency, now);
    // eslint-disable-next-line no-await-in-loop
    await schedule.save();
  }
  return { sent, failed };
}
