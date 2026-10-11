import Bill from './bill.model.js';
import Adjustment from './adjustment.model.js';
import Payment from '../payments/payment.model.js';
import Unit from '../units/unit.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import { creditBalance } from './adjustments.service.js';
import { statementPdf } from './documents.js';
import { workbookBuffer } from './sheets.js';

const periodText = (p) => (p === 'OPENING' ? 'opening balance' : new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }));

// Ledger of one unit. Debits raise what the household owes (bills, late fees, bounced payments, refunds
// of advance); credits lower it (payments, waivers, credit notes, opening advances). Advance applied to a
// bill moves money between the household's own buckets, so it does not change the running balance.
// A positive balance is payable; a negative balance is advance held.
export async function statement(ctx, { unit: unitId, from, to }) {
  const id = ctx.role === ROLES.RESIDENT ? ctx.unitId : unitId;
  if (!id) throw ApiError.badRequest('Choose a unit');
  const unit = await Unit.findOne({ _id: id, society: ctx.societyId }).select('label areaSqft occupancy').lean();
  if (!unit) throw ApiError.notFound('Unit not found');
  const end = to ? new Date(to) : new Date();

  const [bills, payments, adjustments, credit] = await Promise.all([
    Bill.find({ society: ctx.societyId, unit: id, status: { $ne: 'cancelled' } }).lean(),
    Payment.find({ society: ctx.societyId, unit: id, status: { $in: ['success', 'bounced'] } }).populate('bill', 'billNumber').lean(),
    Adjustment.find({ society: ctx.societyId, unit: id, status: 'approved', type: { $in: ['waiver', 'credit', 'refund', 'advance'] } }).populate('bill', 'billNumber').lean(),
    creditBalance(ctx.societyId, id),
  ]);

  const entries = [];
  const add = (date, order, type, ref, description, debit, credit_) => entries.push({ date, order, type, ref, description, debit, credit: credit_ });
  for (const b of bills) {
    if (b.kind === 'opening') add(b.dueDate, 0, 'opening', b.billNumber, b.lines[0]?.head || 'Opening balance', b.amount, 0);
    else add(b.createdAt, 1, 'bill', b.billNumber, `Bill ${b.billNumber} · ${periodText(b.period)}`, b.amount, 0);
    if (b.lateFee) add(b.lateFeeAt || b.dueDate, 2, 'late_fee', b.billNumber, `Late fee on ${b.billNumber}`, b.lateFee, 0);
  }
  for (const p of payments) {
    const mode = `${p.method}${p.reference ? ` ${p.reference}` : ''}`;
    const against = p.bill ? ` for ${p.bill.billNumber}` : ' (advance)';
    add(p.paidAt || p.createdAt, 3, 'payment', p.receiptNumber, `Payment ${p.receiptNumber || ''} · ${mode}${against}`.trim(), 0, p.amount);
    if (p.status === 'bounced') add(p.bouncedAt, 4, 'bounce', p.receiptNumber, `Payment ${p.receiptNumber} bounced${p.bounceReason ? `: ${p.bounceReason}` : ''}`, p.amount, 0);
  }
  for (const a of adjustments) {
    if (a.type === 'advance' && a.payment) continue; // the payment itself is already a credit
    const date = a.type === 'advance' ? a.effectiveDate || a.createdAt : a.type === 'waiver' ? a.approvedAt || a.createdAt : a.createdAt;
    const text = {
      waiver: `Waiver ${a.number || ''} on ${a.bill?.billNumber || 'bill'}${a.reason ? ` · ${a.reason}` : ''}`,
      credit: `Credit note ${a.number || ''}${a.reason ? ` · ${a.reason}` : ''}`,
      refund: `Advance refunded ${a.number || ''} · ${a.method || ''}${a.reference ? ` ${a.reference}` : ''}`,
      advance: a.reason || 'Advance',
    }[a.type];
    if (a.type === 'refund') add(date, 5, a.type, a.number, text, a.amount, 0);
    else add(date, a.type === 'advance' ? 0 : 5, a.type, a.number, text, 0, a.amount);
  }
  entries.sort((x, y) => new Date(x.date) - new Date(y.date) || x.order - y.order);

  const start = from ? new Date(from) : null;
  let opening = 0;
  let balance = 0;
  const shown = [];
  const totals = { debit: 0, credit: 0 };
  for (const e of entries) {
    if (new Date(e.date) > end) continue;
    balance += e.debit - e.credit;
    if (start && new Date(e.date) < start) {
      opening = balance;
      continue;
    }
    totals.debit += e.debit;
    totals.credit += e.credit;
    shown.push({ date: e.date, type: e.type, ref: e.ref, description: e.description, debit: e.debit, credit: e.credit, balance });
  }

  const outstanding = bills.filter((b) => ['unpaid', 'partial'].includes(b.status)).reduce((s, b) => s + Math.max(0, b.total - b.paid), 0);
  const pendingCharges = await Adjustment.aggregate([
    { $match: { society: ctx.societyId, unit: unit._id, type: 'bounce_charge', status: 'approved', bill: null } },
    { $group: { _id: null, sum: { $sum: '$amount' } } },
  ]);
  return {
    unit,
    from: start,
    to: end,
    openingBalance: opening,
    entries: shown,
    totals,
    closingBalance: balance,
    outstanding,
    creditBalance: credit,
    unbilledCharges: pendingCharges[0]?.sum || 0,
  };
}

export async function statementPdfBuffer(ctx, q) {
  const [s, society] = await Promise.all([statement(ctx, q), Society.findById(ctx.societyId).select('name address city state pincode').lean()]);
  return { filename: `statement-${s.unit.label}.pdf`, buffer: await statementPdf({ society, statement: s }) };
}

export async function statementXlsxBuffer(ctx, q) {
  const s = await statement(ctx, q);
  const r = (p) => Math.round(p) / 100;
  const rows = [
    { date: s.from ? s.from.toISOString().slice(0, 10) : '', particulars: 'Opening balance', debit: null, credit: null, balance: r(s.openingBalance) },
    ...s.entries.map((e) => ({ date: new Date(e.date).toISOString().slice(0, 10), particulars: e.description, ref: e.ref || '', debit: e.debit ? r(e.debit) : null, credit: e.credit ? r(e.credit) : null, balance: r(e.balance) })),
    { date: '', particulars: 'Closing balance', debit: r(s.totals.debit), credit: r(s.totals.credit), balance: r(s.closingBalance) },
    {},
    { particulars: 'Outstanding dues', balance: r(s.outstanding) },
    { particulars: 'Advance balance', balance: r(s.creditBalance) },
  ];
  const money = '#,##0.00';
  const buffer = await workbookBuffer(
    'Statement',
    [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Particulars', key: 'particulars', width: 52 },
      { header: 'Ref', key: 'ref', width: 16 },
      { header: 'Debit (₹)', key: 'debit', width: 14, numFmt: money },
      { header: 'Credit (₹)', key: 'credit', width: 14, numFmt: money },
      { header: 'Balance (₹)', key: 'balance', width: 14, numFmt: money },
    ],
    rows,
    { title: `Statement of account · ${s.unit.label}` },
  );
  return { filename: `statement-${s.unit.label}.xlsx`, buffer };
}
