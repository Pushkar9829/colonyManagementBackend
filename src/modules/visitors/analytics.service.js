import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import Visitor from './visitor.model.js';
import { APP_TIMEZONE, addDays, localDateString, startOfLocalDay } from '../../common/utils/dates.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_RANGE_DAYS = 366;
const at = { $ifNull: ['$occurredAt', '$createdAt'] };

// Default range: the last 30 local days including today.
function range({ from, to }) {
  const end = to || addDays(startOfLocalDay(), 1);
  let start = from || addDays(startOfLocalDay(), -29);
  if (end - start > MAX_RANGE_DAYS * 86400000) start = addDays(end, -MAX_RANGE_DAYS);
  return { start, end };
}

export async function summary(ctx, filters) {
  const { start, end } = range(filters);
  const society = new mongoose.Types.ObjectId(String(ctx.societyId));
  const [result] = await Visitor.aggregate([
    { $match: { society, createdAt: { $gte: addDays(start, -8), $lt: addDays(end, 1) } } },
    { $addFields: { at } },
    { $match: { at: { $gte: start, $lt: end } } },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              denied: { $sum: { $cond: [{ $eq: ['$status', 'denied'] }, 1, 0] } },
              blocked: { $sum: { $cond: [{ $eq: ['$flag.type', 'block'] }, 1, 0] } },
              watch: { $sum: { $cond: [{ $eq: ['$flag.type', 'watch'] }, 1, 0] } },
              preApproved: { $sum: { $cond: [{ $ifNull: ['$pass', false] }, 1, 0] } },
              autoApproved: { $sum: { $cond: ['$autoApproved', 1, 0] } },
              leftAtGate: { $sum: { $cond: ['$leftAtGate', 1, 0] } },
              escalated: { $sum: { $cond: [{ $ifNull: ['$escalatedAt', false] }, 1, 0] } },
              guests: { $sum: { $ifNull: ['$guests', 1] } },
            },
          },
        ],
        byPurpose: [{ $group: { _id: '$purpose', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        perDay: [{ $group: { _id: { $dateToString: { date: '$at', format: '%Y-%m-%d', timezone: APP_TIMEZONE } }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
        heatmap: [
          { $group: { _id: { dow: { $subtract: [{ $dayOfWeek: { date: '$at', timezone: APP_TIMEZONE } }, 1] }, hour: { $hour: { date: '$at', timezone: APP_TIMEZONE } } }, count: { $sum: 1 } } },
        ],
        // Time from arrival to the household's answer (guard overrides and auto-approvals excluded).
        approval: [
          { $match: { respondedAt: { $ne: null }, pass: null, autoApproved: { $ne: true }, status: { $in: ['checked_in', 'checked_out', 'denied'] }, 'flag.type': { $ne: 'block' } } },
          { $project: { ms: { $subtract: ['$respondedAt', '$at'] } } },
          { $match: { ms: { $gte: 0 } } },
          { $group: { _id: null, avgMs: { $avg: '$ms' }, maxMs: { $max: '$ms' }, n: { $sum: 1 } } },
        ],
        topVisitors: [
          { $match: { purpose: { $in: ['guest', 'service', 'other'] } } },
          { $group: { _id: { $ifNull: ['$phone', { $toLower: '$name' }] }, name: { $last: '$name' }, phone: { $last: '$phone' }, count: { $sum: 1 }, lastAt: { $max: '$at' } } },
          { $match: { count: { $gt: 1 } } },
          { $sort: { count: -1, lastAt: -1 } },
          { $limit: 10 },
        ],
        topCompanies: [
          { $match: { company: { $nin: [null, ''] } } },
          { $group: { _id: { $toLower: '$company' }, company: { $first: '$company' }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ],
      },
    },
  ]);

  // Fill gaps so the UI can draw a continuous day series and a full 7x24 table.
  const days = [];
  for (let d = start; d < end; d = addDays(d, 1)) days.push(localDateString(d));
  const perDayMap = new Map(result.perDay.map((r) => [r._id, r.count]));
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of result.heatmap) heat[r._id.dow][r._id.hour] = r.count;
  const approval = result.approval[0];
  const totals = result.totals[0] || { total: 0, denied: 0, blocked: 0, watch: 0, preApproved: 0, autoApproved: 0, leftAtGate: 0, escalated: 0, guests: 0 };
  delete totals._id;

  return {
    from: start,
    to: end,
    totals,
    byPurpose: result.byPurpose.map((r) => ({ purpose: r._id, count: r.count })),
    byStatus: result.byStatus.map((r) => ({ status: r._id, count: r.count })),
    perDay: [...new Set(days)].map((date) => ({ date, count: perDayMap.get(date) || 0 })),
    heatmap: heat.map((hours, dow) => ({ dow, day: DAY_NAMES[dow], hours })),
    approval: { avgSeconds: approval ? Math.round(approval.avgMs / 1000) : null, maxSeconds: approval ? Math.round(approval.maxMs / 1000) : null, responses: approval?.n || 0 },
    topVisitors: result.topVisitors.map((r) => ({ name: r.name, phone: r.phone || null, visits: r.count, lastAt: r.lastAt })),
    topCompanies: result.topCompanies.map((r) => ({ company: r.company, count: r.count })),
  };
}

const header = (ws) => {
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
};

// Excel workbook: summary, per-day, hourly heatmap, purposes, top visitors and the raw entries.
export async function exportWorkbook(ctx, filters) {
  const data = await summary(ctx, filters);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ColonyHub';
  wb.created = new Date();

  const s = wb.addWorksheet('Summary');
  s.columns = [{ header: 'Metric', key: 'k', width: 34 }, { header: 'Value', key: 'v', width: 18 }];
  const rows = [
    ['From', localDateString(data.from)],
    ['To (exclusive)', localDateString(data.to)],
    ['Total entries', data.totals.total],
    ['Denied', data.totals.denied],
    ['Blocked by blocklist', data.totals.blocked],
    ['Watchlist flags', data.totals.watch],
    ['Pre-approved (pass)', data.totals.preApproved],
    ['Auto-approved (frequent)', data.totals.autoApproved],
    ['Deliveries left at gate', data.totals.leftAtGate],
    ['Escalated (no answer)', data.totals.escalated],
    ['Average approval time (seconds)', data.approval.avgSeconds ?? '—'],
  ];
  rows.forEach(([k, v]) => s.addRow({ k, v }));
  header(s);

  const d = wb.addWorksheet('Per day');
  d.columns = [{ header: 'Date', key: 'date', width: 14 }, { header: 'Entries', key: 'count', width: 10 }];
  data.perDay.forEach((r) => d.addRow(r));
  header(d);

  const h = wb.addWorksheet('By hour');
  h.columns = [{ header: 'Day', key: 'day', width: 8 }, ...Array.from({ length: 24 }, (_, i) => ({ header: String(i).padStart(2, '0'), key: `h${i}`, width: 5 }))];
  data.heatmap.forEach((r) => h.addRow({ day: r.day, ...Object.fromEntries(r.hours.map((c, i) => [`h${i}`, c])) }));
  header(h);

  const p = wb.addWorksheet('By purpose');
  p.columns = [{ header: 'Purpose', key: 'purpose', width: 14 }, { header: 'Entries', key: 'count', width: 10 }];
  data.byPurpose.forEach((r) => p.addRow(r));
  header(p);

  const t = wb.addWorksheet('Top visitors');
  t.columns = [{ header: 'Name', key: 'name', width: 26 }, { header: 'Phone', key: 'phone', width: 16 }, { header: 'Visits', key: 'visits', width: 8 }, { header: 'Last visit', key: 'lastAt', width: 20 }];
  data.topVisitors.forEach((r) => t.addRow({ ...r, lastAt: r.lastAt ? new Date(r.lastAt).toLocaleString('en-IN', { timeZone: APP_TIMEZONE }) : '' }));
  header(t);

  const e = wb.addWorksheet('Entries');
  e.columns = [
    { header: 'Time', key: 'time', width: 20 },
    { header: 'Unit', key: 'unit', width: 10 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Phone', key: 'phone', width: 14 },
    { header: 'Purpose', key: 'purpose', width: 10 },
    { header: 'Company', key: 'company', width: 14 },
    { header: 'Vehicle', key: 'vehicle', width: 12 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Flag', key: 'flag', width: 8 },
    { header: 'Check in', key: 'in', width: 20 },
    { header: 'Check out', key: 'out', width: 20 },
  ];
  const fmt = (x) => (x ? new Date(x).toLocaleString('en-IN', { timeZone: APP_TIMEZONE }) : '');
  const entries = await Visitor.find({ society: ctx.societyId, createdAt: { $gte: addDays(data.from, -8), $lt: addDays(data.to, 1) } })
    .sort({ createdAt: 1 })
    .limit(20000)
    .populate('unit', 'label')
    .lean();
  for (const v of entries) {
    const when = v.occurredAt || v.createdAt;
    if (when < data.from || when >= data.to) continue;
    e.addRow({ time: fmt(when), unit: v.unit?.label, name: v.name, phone: v.phone, purpose: v.purpose, company: v.company, vehicle: v.vehicleNumber, status: v.status, flag: v.flag?.type || '', in: fmt(v.checkInAt), out: fmt(v.checkOutAt) });
  }
  header(e);

  return { buffer: await wb.xlsx.writeBuffer(), filename: `visitors-${localDateString(data.from)}-to-${localDateString(addDays(data.to, -1))}.xlsx` };
}
