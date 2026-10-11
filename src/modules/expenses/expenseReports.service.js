import VendorBill from './vendorBill.model.js';
import JournalEntry from '../accounting/journalEntry.model.js';
import { localDateString } from '../../common/utils/dates.js';
import { accountsByCode } from '../accounting/ledger.service.js';
import { resolveRange } from '../accounting/reports.service.js';
import { OPEN_BILL, VENDOR_CATEGORIES } from './constants.js';

const BUCKETS = [
  { key: 'd0_30', label: '0-30 days', max: 30 },
  { key: 'd31_60', label: '31-60 days', max: 60 },
  { key: 'd61_90', label: '61-90 days', max: 90 },
  { key: 'd90_plus', label: '90+ days', max: Infinity },
];
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/**
 * Payables ageing by vendor. Age counts from the bill date; "overdue" is the part past its due date.
 * Balances are current balances of bills dated on or before asOf.
 */
export async function ageing(ctx, { asOf }) {
  const date = asOf || localDateString();
  const bills = await VendorBill.find({ society: ctx.societyId, status: { $in: OPEN_BILL }, billDate: { $lte: date } })
    .select('vendor number billNo billDate dueDate payable paid')
    .populate('vendor', 'name category')
    .lean();
  const byVendor = new Map();
  const totals = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, overdue: 0, total: 0, bills: 0 };
  for (const b of bills) {
    const balance = b.payable - b.paid;
    if (balance <= 0) continue;
    const age = Math.max(0, daysBetween(b.billDate, date));
    const bucket = BUCKETS.find((x) => age <= x.max).key;
    const k = String(b.vendor?._id || b.vendor);
    if (!byVendor.has(k)) byVendor.set(k, { vendorId: k, vendor: b.vendor?.name || 'Unknown', category: b.vendor?.category, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, overdue: 0, total: 0, bills: 0, oldest: b.billDate });
    const row = byVendor.get(k);
    row[bucket] += balance;
    row.total += balance;
    row.bills += 1;
    if (b.dueDate < date) row.overdue += balance;
    if (b.billDate < row.oldest) row.oldest = b.billDate;
    totals[bucket] += balance;
    totals.total += balance;
    totals.bills += 1;
    if (b.dueDate < date) totals.overdue += balance;
  }
  return { asOf: date, buckets: BUCKETS.map(({ key, label }) => ({ key, label })), rows: [...byVendor.values()].sort((a, b) => b.total - a.total), totals };
}

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const end = to.slice(0, 7);
  for (let i = 0; i < 120; i += 1) {
    const p = `${y}-${String(m).padStart(2, '0')}`;
    out.push(p);
    if (p >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Expenses by month. groupBy 'account' reads the ledger (every expense: vendor bills, payroll,
 * bank charges, manual journals); 'category' reads vendor bills by vendor category (incl. GST not claimed).
 */
export async function expenseReport(ctx, { from, to, groupBy = 'account' }) {
  const range = resolveRange({ from, to });
  const months = monthsBetween(range.from, range.to);
  const rows = new Map();
  const add = (key, label, month, amount) => {
    if (!rows.has(key)) rows.set(key, { key, label, months: {}, total: 0 });
    const r = rows.get(key);
    r.months[month] = (r.months[month] || 0) + amount;
    r.total += amount;
  };

  if (groupBy === 'category') {
    const bills = await VendorBill.find({ society: ctx.societyId, status: { $ne: 'cancelled' }, billDate: { $gte: range.from, $lte: range.to } })
      .select('billDate subtotal gstAmount claimGst vendor')
      .populate('vendor', 'category')
      .lean();
    for (const b of bills) {
      const cat = b.vendor?.category || 'other';
      add(cat, cat.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), b.billDate.slice(0, 7), b.subtotal + (b.claimGst ? 0 : b.gstAmount));
    }
  } else {
    const accounts = await accountsByCode(ctx.societyId);
    const expenseCodes = [...accounts.values()].filter((a) => a.type === 'expense').map((a) => a.code);
    const agg = await JournalEntry.aggregate([
      { $match: { society: ctx.societyId, date: { $gte: range.from, $lte: range.to }, 'lines.code': { $in: expenseCodes } } },
      { $unwind: '$lines' },
      { $match: { 'lines.code': { $in: expenseCodes } } },
      { $group: { _id: { code: '$lines.code', month: { $substrBytes: ['$date', 0, 7] } }, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]);
    for (const r of agg) {
      const a = accounts.get(r._id.code);
      add(r._id.code, `${r._id.code} ${a?.name || ''}`.trim(), r._id.month, r.debit - r.credit);
    }
  }
  const list = [...rows.values()].filter((r) => r.total !== 0).sort((a, b) => (groupBy === 'category' ? VENDOR_CATEGORIES.indexOf(a.key) - VENDOR_CATEGORIES.indexOf(b.key) : a.key.localeCompare(b.key)));
  const totals = Object.fromEntries(months.map((m) => [m, list.reduce((s, r) => s + (r.months[m] || 0), 0)]));
  return { ...range, groupBy, months, rows: list, totals, total: list.reduce((s, r) => s + r.total, 0) };
}

// Table specs for Excel / PDF downloads (rendered by accounting/exports.service.js).
export function ageingTable(data, society) {
  return {
    title: 'Payables ageing',
    subtitle: `${society} · as of ${data.asOf} · age from bill date`,
    columns: [
      { header: 'Vendor', key: 'vendor', width: 30 },
      { header: '0-30', key: 'd0_30', type: 'money' },
      { header: '31-60', key: 'd31_60', type: 'money' },
      { header: '61-90', key: 'd61_90', type: 'money' },
      { header: '90+', key: 'd90_plus', type: 'money' },
      { header: 'Total', key: 'total', type: 'money' },
      { header: 'Overdue', key: 'overdue', type: 'money' },
    ],
    rows: [...data.rows, { vendor: 'Total', ...data.totals, _style: 'total' }],
  };
}

export function expenseTable(data, society) {
  const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  return {
    title: `Expenses by ${data.groupBy === 'category' ? 'vendor category' : 'account'}`,
    subtitle: `${society} · ${data.from} to ${data.to}`,
    columns: [
      { header: data.groupBy === 'category' ? 'Category' : 'Account', key: 'label', width: 30, pdfWeight: 2 },
      ...data.months.map((m) => ({ header: monthLabel(m), key: m, type: 'money', width: 13 })),
      { header: 'Total', key: 'total', type: 'money' },
    ],
    rows: [
      ...data.rows.map((r) => ({ label: r.label, ...r.months, total: r.total })),
      { label: 'Total', ...data.totals, total: data.total, _style: 'total' },
    ],
  };
}
