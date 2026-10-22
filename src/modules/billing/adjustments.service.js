import Adjustment, { CREDIT_IN, CREDIT_OUT } from './adjustment.model.js';
import Bill from './bill.model.js';
import UnitCredit from './unitCredit.model.js';
import Unit from '../units/unit.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { withTransaction } from '../../common/utils/transaction.js';
import { money } from '../../common/utils/money.js';
import { ROLES } from '../../common/constants/index.js';
import { nextNumber } from '../counter/counter.service.js';
import { notifyRoles, notifyUnit, notifyUsers } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import * as audit from '../audit/audit.service.js';
import * as financeSettings from '../financeSettings/financeSettings.service.js';
import { OPEN, addPaid, addWaiver } from './billOps.js';
import { parseDateCell, parseNumber, readSheet } from './sheets.js';

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
const POPULATE = [
  { path: 'unit', select: 'label' },
  { path: 'bill', select: 'billNumber period' },
  { path: 'payment', select: 'receiptNumber method reference' },
  { path: 'requestedBy', select: 'name' },
  { path: 'approvedBy', select: 'name' },
];

const refresh = (societyId, unit) => invalidate(societyId, ['bills', 'payments', 'finance'], { unit });

async function createAdjustment(societyId, data, session) {
  const number = await nextNumber(societyId, 'adjustment', 'ADJ');
  const [doc] = await Adjustment.create([{ society: societyId, number, status: 'approved', ...data }], { session });
  return doc;
}

// ---------- advance credit wallet ----------
export async function creditBalance(societyId, unitId) {
  const doc = await UnitCredit.findOne({ society: societyId, unit: unitId }).select('balance').lean();
  return doc?.balance || 0;
}

export async function creditBalances(societyId, unitIds) {
  const docs = await UnitCredit.find({ society: societyId, unit: { $in: unitIds }, balance: { $gt: 0 } }).select('unit balance').lean();
  return new Map(docs.map((d) => [String(d.unit), d.balance]));
}

async function creditIn(societyId, unitId, amount, session) {
  try {
    await UnitCredit.updateOne({ society: societyId, unit: unitId }, { $inc: { balance: amount } }, { upsert: true, session });
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Two first-time upserts raced on the unique index; the document exists now.
    await UnitCredit.updateOne({ society: societyId, unit: unitId }, { $inc: { balance: amount } }, { session });
  }
}

async function creditOut(societyId, unitId, amount, session) {
  const r = await UnitCredit.updateOne({ society: societyId, unit: unitId, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { session });
  return r.modifiedCount === 1;
}

// Adds advance/credit to a unit: type 'advance' (money received, optionally with its payment) or 'credit'
// (credit note). Returns the adjustment.
export async function addCredit(ctx, { unit, type = 'advance', amount, reason, payment, effectiveDate }, session) {
  if (!CREDIT_IN.includes(type)) throw new Error(`addCredit: bad type ${type}`);
  const adj = await createAdjustment(ctx.societyId, { unit, type, amount, reason, payment, effectiveDate, requestedBy: ctx.userId, approvedBy: ctx.userId, approvedAt: new Date() }, session);
  await creditIn(ctx.societyId, unit, amount, session);
  return adj;
}

// Reverses an 'advance' created by a payment that later bounced. Fails if the credit was already used.
export async function reverseAdvance(ctx, paymentId, reason, session) {
  const adj = await Adjustment.findOne({ society: ctx.societyId, payment: paymentId, type: 'advance', status: 'approved' }).session(session || null);
  if (!adj) return null;
  if (!(await creditOut(ctx.societyId, adj.unit, adj.amount, session))) {
    throw ApiError.conflict('The advance from this payment ({amount}) has already been used on bills. Reverse those first.', { params: { amount: money(adj.amount) } });
  }
  adj.status = 'rejected';
  adj.decisionNote = reason;
  adj.approvedBy = ctx.userId;
  adj.approvedAt = new Date();
  await adj.save({ session });
  return adj;
}

// Uses the unit's advance credit on one open bill. Returns the amount applied (0 if none).
export async function applyCreditToBill(ctx, bill) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [available, fresh] = await Promise.all([creditBalance(ctx.societyId, bill.unit), Bill.findOne({ _id: bill._id, society: ctx.societyId }).select('total paid status').lean()]);
    if (!fresh || !OPEN.includes(fresh.status)) return 0;
    const amount = Math.min(available, fresh.total - fresh.paid);
    if (amount <= 0) return 0;
    // eslint-disable-next-line no-await-in-loop
    const applied = await withTransaction(async (session) => {
      if (!(await creditOut(ctx.societyId, bill.unit, amount, session))) return 0;
      const updated = await addPaid(ctx.societyId, bill._id, amount, { fromCredit: true, session });
      if (!updated) {
        await creditIn(ctx.societyId, bill.unit, amount, session); // bill changed meanwhile: give the credit back
        return 0;
      }
      await createAdjustment(ctx.societyId, { unit: bill.unit, bill: bill._id, type: 'credit_applied', amount, reason: `Advance applied to ${updated.billNumber}`, requestedBy: ctx.userId, approvedBy: ctx.userId, approvedAt: new Date() }, session);
      return amount;
    });
    if (applied) {
      audit.record(ctx, 'bill.credit_applied', 'Bill', bill._id, { amount });
      return applied;
    }
  }
  return 0;
}

// Applies available credit to the unit's open bills, oldest due first.
export async function applyCreditToOpenBills(ctx, unitId) {
  const unit = await Unit.findOne({ _id: unitId, society: ctx.societyId }).select('_id').lean();
  if (!unit) throw ApiError.notFound('Unit not found');
  const bills = await Bill.find({ society: ctx.societyId, unit: unitId, status: { $in: OPEN } }).sort({ dueDate: 1 }).select('_id unit').lean();
  let applied = 0;
  for (const b of bills) {
    // eslint-disable-next-line no-await-in-loop
    const x = await applyCreditToBill(ctx, b);
    applied += x;
    if (!x) break;
  }
  if (applied) refresh(ctx.societyId, unitId);
  return { applied, bills: bills.length, creditBalance: await creditBalance(ctx.societyId, unitId) };
}

export async function issueCredit(ctx, { unit, amount, reason }) {
  if (!(await Unit.exists({ _id: unit, society: ctx.societyId }))) throw ApiError.notFound('Unit not found');
  const adj = await withTransaction((session) => addCredit(ctx, { unit, type: 'credit', amount, reason }, session));
  audit.record(ctx, 'adjustment.credit_issued', 'Adjustment', adj._id, { amount, reason });
  await notifyUnit(ctx.societyId, unit, { type: 'bill', title: 'Credit added to your account', body: `${money(amount)} · ${reason}`, link: '/billing', channels: ['inapp', 'push'] });
  refresh(ctx.societyId, unit);
  return Adjustment.findById(adj._id).populate(POPULATE).lean();
}

// Pays back unused advance credit.
export async function refund(ctx, { unit, amount, method, reference, reason }) {
  if (!(await Unit.exists({ _id: unit, society: ctx.societyId }))) throw ApiError.notFound('Unit not found');
  const adj = await withTransaction(async (session) => {
    if (!(await creditOut(ctx.societyId, unit, amount, session))) throw ApiError.badRequest('Refund exceeds the advance balance ({balance})', { params: { balance: money(await creditBalance(ctx.societyId, unit)) } });
    return createAdjustment(ctx.societyId, { unit, type: 'refund', amount, method, reference, reason: reason || 'Advance refund', requestedBy: ctx.userId, approvedBy: ctx.userId, approvedAt: new Date() }, session);
  });
  audit.record(ctx, 'adjustment.refund', 'Adjustment', adj._id, { amount, method, reference });
  await notifyUnit(ctx.societyId, unit, { type: 'bill', title: 'Advance refunded', body: `${money(amount)} by ${method}${reference ? ` (${reference})` : ''}`, link: '/billing', channels: ['inapp', 'push', 'email'] });
  refresh(ctx.societyId, unit);
  return Adjustment.findById(adj._id).populate(POPULATE).lean();
}

// ---------- cheque bounce charges ----------
export function recordBounceCharge(ctx, { unit, payment, amount, reason }, session) {
  return createAdjustment(ctx.societyId, { unit, payment, type: 'bounce_charge', amount, reason, requestedBy: ctx.userId, approvedBy: ctx.userId, approvedAt: new Date() }, session);
}

// Bounce charges not yet put on a bill, per unit.
export async function unbilledCharges(societyId, unitIds) {
  const docs = await Adjustment.find({ society: societyId, unit: { $in: unitIds }, type: 'bounce_charge', status: 'approved', bill: null }).select('unit amount reason').lean();
  const map = new Map();
  for (const d of docs) {
    if (!map.has(String(d.unit))) map.set(String(d.unit), []);
    map.get(String(d.unit)).push(d);
  }
  return map;
}

export const markCharged = (societyId, adjustmentIds, billByAdjustment) =>
  Adjustment.bulkWrite(adjustmentIds.map((id) => ({ updateOne: { filter: { _id: id, society: societyId, bill: null }, update: { $set: { bill: billByAdjustment.get(String(id)) } } } })));

// ---------- late-fee waivers (maker-checker) ----------
export async function requestWaiver(ctx, { bill: billId, amount, reason }) {
  const bill = await Bill.findOne({ _id: billId, society: ctx.societyId }).lean();
  if (!bill) throw ApiError.notFound('Bill not found');
  if (!OPEN.includes(bill.status)) throw ApiError.conflict('Bill is {status}', { params: { status: bill.status } });
  const balance = bill.total - bill.paid;
  if (amount > balance) throw ApiError.badRequest('Waiver cannot exceed the bill balance ({amount})', { params: { amount: money(balance) } });
  if (await Adjustment.exists({ society: ctx.societyId, bill: bill._id, type: 'waiver', status: 'pending' })) {
    throw ApiError.conflict('A waiver for this bill is already awaiting approval');
  }
  const settings = await financeSettings.forSociety(ctx.societyId);
  const adj = await createAdjustment(ctx.societyId, { unit: bill.unit, bill: bill._id, type: 'waiver', amount, reason, status: 'pending', requestedBy: ctx.userId });
  audit.record(ctx, 'waiver.requested', 'Adjustment', adj._id, { bill: bill.billNumber, amount });
  if (!settings.waiverApprovalRequired) return decideWaiver(ctx, adj._id, 'approve', undefined, { selfApprove: true });
  await notifyRoles(ctx.societyId, [ROLES.ADMIN], {
    type: 'finance',
    title: 'Waiver awaiting approval',
    body: `${money(amount)} on ${bill.billNumber} · ${reason}`,
    link: '/billing?tab=waivers',
    channels: ['inapp', 'push'],
  });
  invalidate(ctx.societyId, ['finance'], { roles: [ROLES.ADMIN, ROLES.ACCOUNTANT] });
  return Adjustment.findById(adj._id).populate(POPULATE).lean();
}

// The checker (an admin other than the maker) approves or rejects. Approval lowers the bill total.
export async function decideWaiver(ctx, id, decision, note, { selfApprove = false } = {}) {
  const adj = await Adjustment.findOne({ _id: id, society: ctx.societyId, type: 'waiver' }).lean();
  if (!adj) throw ApiError.notFound('Waiver not found');
  if (adj.status !== 'pending') throw ApiError.conflict('Waiver is already {status}', { params: { status: adj.status } });
  if (!selfApprove && String(adj.requestedBy) === String(ctx.userId)) throw ApiError.forbidden('The person who requested a waiver cannot approve it');

  const status = decision === 'approve' ? 'approved' : 'rejected';
  const claimed = await Adjustment.findOneAndUpdate(
    { _id: id, society: ctx.societyId, status: 'pending' },
    { status, approvedBy: ctx.userId, approvedAt: new Date(), decisionNote: note },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw ApiError.conflict('Waiver was decided by someone else');

  if (status === 'approved') {
    const bill = await addWaiver(ctx.societyId, adj.bill, adj.amount);
    if (!bill) {
      await Adjustment.updateOne({ _id: id }, { status: 'pending', $unset: { approvedBy: 1, approvedAt: 1, decisionNote: 1 } });
      throw ApiError.conflict('The bill balance is now lower than the waiver. Reject it and request a new amount.');
    }
    audit.record(ctx, 'waiver.approved', 'Adjustment', id, { bill: bill.billNumber, amount: adj.amount });
    await notifyUnit(ctx.societyId, adj.unit, {
      type: 'bill',
      title: `${money(adj.amount)} waived on ${bill.billNumber}`,
      body: bill.total > bill.paid ? `New balance ${money(bill.total - bill.paid)}` : 'Nothing more is due on this bill',
      link: '/billing',
      channels: ['inapp', 'push', 'email'],
    });
  } else {
    audit.record(ctx, 'waiver.rejected', 'Adjustment', id, { amount: adj.amount, note });
  }
  if (!selfApprove) {
    await notifyUsers(ctx.societyId, [adj.requestedBy], {
      type: 'finance',
      title: `Waiver ${status}`,
      body: `${money(adj.amount)}${note ? ` · ${note}` : ''}`,
      link: '/billing?tab=waivers',
      channels: ['inapp'],
    });
  }
  refresh(ctx.societyId, adj.unit);
  return Adjustment.findById(id).populate(POPULATE).lean();
}

// ---------- listing ----------
export function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) {
    filter.unit = ctx.unitId;
    filter.status = 'approved';
  } else {
    if (filters.unit) filter.unit = filters.unit;
    if (filters.status) filter.status = filters.status;
  }
  if (filters.type) filter.type = filters.type;
  return paginate(Adjustment, filter, pagination, { sort: { createdAt: -1 }, populate: POPULATE });
}

// Units holding advance credit (for the accountant's credits view).
export async function creditHolders(ctx) {
  return UnitCredit.find({ society: ctx.societyId, balance: { $gt: 0 } }).sort({ balance: -1 }).limit(500).populate('unit', 'label').select('unit balance updatedAt').lean();
}

// ---------- opening balances ----------
// rows: [{ unit: 'A-101', amount (paise; negative = advance held), asOf: 'YYYY-MM-DD', row? }]
// Dues create an 'opening_balance' adjustment plus an opening bill (period 'OPENING', due on the as-of
// date) so they show in defaulters and can be paid like any bill. Advances go to the credit wallet.
// A unit can be imported once; re-importing reports it as skipped.
export async function importOpeningBalances(ctx, rows, { dryRun = false } = {}) {
  const labels = [...new Set(rows.map((r) => String(r.unit).trim().toUpperCase()))];
  const units = new Map((await Unit.find({ society: ctx.societyId, label: { $in: labels } }).select('label').lean()).map((u) => [u.label.toUpperCase(), u]));
  const done = new Set(
    (await Adjustment.find({ society: ctx.societyId, unit: { $in: [...units.values()].map((u) => u._id) }, $or: [{ type: 'opening_balance' }, { type: 'advance', payment: null, effectiveDate: { $ne: null } }] }).select('unit').lean()).map((a) => String(a.unit)),
  );
  const results = [];
  const seen = new Set();
  for (const r of rows) {
    const label = String(r.unit).trim().toUpperCase();
    const unit = units.get(label);
    const base = { row: r.row, unit: label, amount: r.amount };
    if (!unit) results.push({ ...base, ok: false, error: 'Unknown unit' });
    else if (!Number.isInteger(r.amount) || r.amount === 0) results.push({ ...base, ok: false, error: 'Amount must be a non-zero number' });
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(r.asOf || '')) results.push({ ...base, ok: false, error: 'As of date must be YYYY-MM-DD' });
    else if (done.has(String(unit._id)) || seen.has(String(unit._id))) results.push({ ...base, ok: false, skipped: true, error: 'Opening balance already imported for this unit' });
    else {
      seen.add(String(unit._id));
      results.push({ ...base, ok: true, unitId: unit._id, asOf: r.asOf, kind: r.amount > 0 ? 'dues' : 'advance' });
    }
  }
  const valid = results.filter((r) => r.ok);
  if (dryRun) return { dryRun: true, valid: valid.length, failed: results.length - valid.length, results: results.map(({ unitId, ...x }) => x) };

  for (const r of valid) {
    const asOf = new Date(`${r.asOf}T00:00:00+05:30`);
    try {
      // eslint-disable-next-line no-await-in-loop
      await withTransaction(async (session) => {
        if (r.amount > 0) {
          const adj = await createAdjustment(ctx.societyId, { unit: r.unitId, type: 'opening_balance', amount: r.amount, reason: `Opening dues as of ${r.asOf}`, effectiveDate: asOf, requestedBy: ctx.userId, approvedBy: ctx.userId, approvedAt: new Date() }, session);
          const billNumber = await nextNumber(ctx.societyId, 'opening-bill', 'OB');
          const [bill] = await Bill.create(
            [{ society: ctx.societyId, unit: r.unitId, period: 'OPENING', kind: 'opening', billNumber, lines: [{ head: `Opening balance as of ${r.asOf}`, amount: r.amount, kind: 'opening' }], amount: r.amount, total: r.amount, dueDate: asOf, generatedBy: ctx.userId, notes: 'Dues brought forward' }],
            { session },
          );
          await Adjustment.updateOne({ _id: adj._id }, { bill: bill._id }, { session });
          r.bill = bill.billNumber;
        } else {
          await addCredit(ctx, { unit: r.unitId, type: 'advance', amount: -r.amount, reason: `Opening advance as of ${r.asOf}`, effectiveDate: asOf }, session);
        }
      });
    } catch (err) {
      r.ok = false;
      r.error = err.code === 11000 ? 'Opening balance already imported for this unit' : err.message;
    }
  }
  const imported = results.filter((r) => r.ok).length;
  audit.record(ctx, 'billing.opening_balances_imported', 'Adjustment', undefined, { imported, failed: results.length - imported });
  invalidate(ctx.societyId, ['bills', 'finance']);
  return { imported, failed: results.length - imported, results: results.map(({ unitId, ...x }) => x) };
}

// Sheet columns: Unit | Amount (₹; negative = advance) | As of (YYYY-MM-DD).
export async function importOpeningBalancesFile(ctx, file, options) {
  const sheet = await readSheet(file);
  const rows = sheet.map((r) => {
    const rupees = parseNumber(r.amount ?? r.amountrs ?? r.amountinr ?? r.dues);
    const asOf = parseDateCell(r.asof ?? r.asofdate ?? r.date);
    return { row: r.row, unit: r.unit ?? r.unitlabel ?? r.flat ?? '', amount: Number.isFinite(rupees) ? Math.round(rupees * 100) : NaN, asOf };
  });
  return importOpeningBalances(ctx, rows, options);
}
