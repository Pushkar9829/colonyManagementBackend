// Automatic posting: reads source documents (bills, payments, adjustments, amenity payments, payslips,
// vendor bills/payments) and makes sure the ledger reflects each one exactly once. Read-only on the
// source collections; every posting is keyed by (sourceType, sourceId) so re-running is harmless.
import mongoose from 'mongoose';
import Bill from '../billing/bill.model.js';
import Payment from '../payments/payment.model.js';
import Society from '../society/society.model.js';
import VendorBill from '../expenses/vendorBill.model.js';
import VendorPayment from '../expenses/vendorPayment.model.js';
import JournalEntry from './journalEntry.model.js';
import SyncState from './syncState.model.js';
import logger from '../../common/utils/logger.js';
import { localDateString } from '../../common/utils/dates.js';
import { ROLES } from '../../common/constants/index.js';
import { CODES } from './chart.js';
import { accountsByCode, ensureChart, postEntry, reverseAllForRef } from './ledger.service.js';
import { postVendorBill, postVendorPayment, reverseVendorBill, reverseVendorPayment } from '../expenses/expenses.posting.js';

// Re-read a few minutes before the saved cursor so documents written while the last run was in
// flight are not missed. Re-processing is idempotent.
const OVERLAP_MS = 10 * 60 * 1000;

// Models owned by other builders that may not exist yet in every deployment. Resolved lazily so this
// module loads (and the rest of the sync works) before they land.
const OPTIONAL_MODELS = {
  Adjustment: '../billing/adjustment.model.js',
  AmenityPayment: '../amenities/amenityPayment.model.js',
  Payslip: '../staffhr/payslip.model.js',
};

async function optionalModel(name) {
  if (mongoose.models[name]) return mongoose.models[name];
  try {
    const mod = await import(new URL(OPTIONAL_MODELS[name], import.meta.url).href);
    return mod.default || mongoose.models[name] || null;
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') logger.warn({ err: err.message, model: name }, 'accounting sync: optional model failed to load');
    return null;
  }
}

const day = (d) => localDateString(d || new Date());
const sumBy = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);

// Live (not reversed, not reversal) entries for a source document.
const liveEntries = (societyId, ref, sourceTypes) =>
  JournalEntry.find({ society: societyId, sourceRef: String(ref), sourceType: { $in: sourceTypes }, reversedBy: null, reversalOf: null }).lean();

// Net movement on one account across entries, seen from `side`.
const netOn = (entries, code, side) =>
  sumBy(entries, (e) => sumBy(e.lines.filter((l) => l.code === code), (l) => (side === 'credit' ? l.credit - l.debit : l.debit - l.credit)));

const tally = (r) => ({ posted: r.posted || 0, reversed: r.reversed || 0 });
const countCreated = (entries) => entries.filter((e) => e?.created).length;

// ---------- per-source handlers: return { posted, reversed } ----------

async function syncBill(ctx, bill, accounts) {
  const id = String(bill._id);
  if (bill.status === 'cancelled') {
    return { reversed: countCreated(await reverseAllForRef(ctx, id, ['bill', 'bill_late_fee'], `Bill ${bill.billNumber} cancelled`, day(bill.updatedAt))) };
  }
  // Opening-balance bills only move dues brought forward; their 'opening_balance' adjustment posts
  // Dr 1100 / Cr 3900, so the bill itself is not income.
  if (bill.kind === 'opening') return {};
  // Each line carries its own income/liability account (GST 2300, funds 3100/3200); default 4000
  // (4900 for cheque-bounce charges billed on a later bill).
  const creditCode = (l) => {
    if (l.account && accounts.has(String(l.account))) return String(l.account);
    return l.kind === 'bounce_charge' ? CODES.OTHER_INCOME : CODES.MAINTENANCE_INCOME;
  };
  const lines = bill.lines.filter((l) => l.amount > 0).map((l) => ({ accountCode: creditCode(l), credit: l.amount, unit: bill.unit, memo: l.head }));
  const lateFee = bill.lateFee || 0;
  if (lateFee > 0) lines.push({ accountCode: CODES.LATE_FEE_INCOME, credit: lateFee, unit: bill.unit, memo: 'Late fee' });
  const receivable = sumBy(lines, (l) => l.credit);
  if (receivable <= 0) return {};
  // Waivers lower bill.total but are posted separately (their adjustment: Dr 5800 / Cr 1100).
  if (receivable !== bill.total + (bill.waived || 0)) logger.warn({ bill: bill.billNumber, total: bill.total, receivable }, 'bill total differs from its lines + late fee');

  const main = await postEntry(ctx, {
    date: day(bill.createdAt),
    narration: `Maintenance bill ${bill.billNumber} (${bill.period})`,
    reference: bill.billNumber,
    sourceType: 'bill',
    sourceId: id,
    lines: [{ accountCode: CODES.MAINTENANCE_RECEIVABLE, debit: receivable, unit: bill.unit }, ...lines],
  });
  if (main.created || main.reversedBy) return { posted: main.created ? 1 : 0 };

  // Late fee changed after the bill was posted: post only the difference.
  const live = await liveEntries(ctx.societyId, id, ['bill', 'bill_late_fee']);
  const delta = lateFee - netOn(live, CODES.LATE_FEE_INCOME, 'credit');
  if (!delta) return {};
  const n = await JournalEntry.countDocuments({ society: ctx.societyId, sourceRef: id, sourceType: 'bill_late_fee' });
  const amount = Math.abs(delta);
  const entry = await postEntry(ctx, {
    date: day(bill.updatedAt),
    narration: `Late fee ${delta > 0 ? 'on' : 'reduced on'} ${bill.billNumber}`,
    reference: bill.billNumber,
    sourceType: 'bill_late_fee',
    sourceId: `${id}:late:${n + 1}`,
    sourceRef: id,
    lines: delta > 0
      ? [{ accountCode: CODES.MAINTENANCE_RECEIVABLE, debit: amount, unit: bill.unit }, { accountCode: CODES.LATE_FEE_INCOME, credit: amount, unit: bill.unit }]
      : [{ accountCode: CODES.LATE_FEE_INCOME, debit: amount, unit: bill.unit }, { accountCode: CODES.MAINTENANCE_RECEIVABLE, credit: amount, unit: bill.unit }],
  });
  return { posted: entry.created ? 1 : 0 };
}

async function syncPayment(ctx, p) {
  const id = String(p._id);
  if (p.status !== 'success') {
    // A bounced (or otherwise undone) receipt is reversed; payments that never succeeded have no entry.
    return { reversed: countCreated(await reverseAllForRef(ctx, id, ['payment'], `Payment ${p.receiptNumber || ''} ${p.status}`.replace(/\s+/g, ' '), day(p.updatedAt))) };
  }
  // Money received = the part applied to the bill (receivable) + any excess held as advance (2100).
  // The matching 'advance' adjustment is therefore not posted again (see adjustmentAccounts).
  const applied = Math.min(p.amount, p.appliedAmount ?? (p.bill ? p.amount : 0));
  const advance = p.amount - applied;
  const entry = await postEntry(ctx, {
    date: day(p.paidAt || p.createdAt),
    narration: `${applied ? 'Maintenance receipt' : 'Advance received'} ${p.receiptNumber || id} (${p.method})`,
    reference: p.reference || p.providerPaymentId || p.receiptNumber,
    sourceType: 'payment',
    sourceId: id,
    lines: [
      { accountCode: p.method === 'cash' ? CODES.CASH : CODES.BANK, debit: p.amount, unit: p.unit },
      { accountCode: CODES.MAINTENANCE_RECEIVABLE, credit: applied, unit: p.unit },
      { accountCode: CODES.MEMBER_ADVANCES, credit: advance, unit: p.unit, memo: advance ? 'Advance' : undefined },
    ],
  });
  return { posted: entry.created ? 1 : 0 };
}

/*
 * [debit, credit] per adjustment type, following the billing module's contract (adjustment.model.js):
 *   waiver          Dr 5800 Waivers        Cr 1100 Receivable
 *   credit          Dr 5800 Waivers        Cr 2100 Member advances   (credit note, no cash)
 *   advance         with `payment`: nothing — the cash and the 2100 credit are in the payment entry;
 *                   without: opening advance, Dr 3900 Cr 2100
 *   credit_applied  Dr 2100 Advances       Cr 1100 Receivable
 *   refund          Dr 2100 Advances       Cr 1000 Bank (1010 when refunded in cash)
 *   bounce_charge   nothing — billed later as a bill line (credited to 4900 there)
 *   opening_balance Dr 1100 Receivable     Cr 3900 Opening balance equity
 */
function adjustmentAccounts(a) {
  switch (a.type) {
    case 'waiver': return [CODES.WAIVERS, CODES.MAINTENANCE_RECEIVABLE];
    case 'credit': return [CODES.WAIVERS, CODES.MEMBER_ADVANCES];
    case 'advance': return a.payment ? null : [CODES.OPENING_BALANCE_EQUITY, CODES.MEMBER_ADVANCES];
    case 'credit_applied': return [CODES.MEMBER_ADVANCES, CODES.MAINTENANCE_RECEIVABLE];
    case 'refund': return [CODES.MEMBER_ADVANCES, a.method === 'cash' ? CODES.CASH : CODES.BANK];
    case 'opening_balance': return [CODES.MAINTENANCE_RECEIVABLE, CODES.OPENING_BALANCE_EQUITY];
    default: return null;
  }
}

async function syncAdjustment(ctx, a) {
  const id = String(a._id);
  const pair = adjustmentAccounts(a);
  if (a.status !== 'approved' || !pair) {
    return { reversed: countCreated(await reverseAllForRef(ctx, id, ['adjustment'], `Adjustment ${a.status}`, day(a.updatedAt))) };
  }
  if (!(a.amount > 0)) return {};
  const entry = await postEntry(ctx, {
    date: day(a.type === 'opening_balance' ? a.effectiveDate || a.approvedAt : a.approvedAt || a.updatedAt),
    narration: `${a.type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())} adjustment${a.reason ? `: ${a.reason}` : a.note ? `: ${a.note}` : ''}`,
    reference: a.reference || a.number,
    sourceType: 'adjustment',
    sourceId: id,
    lines: [
      { accountCode: pair[0], debit: a.amount, unit: a.unit },
      { accountCode: pair[1], credit: a.amount, unit: a.unit },
    ],
  });
  return { posted: entry.created ? 1 : 0 };
}

async function syncAmenityPayment(ctx, p) {
  const id = String(p._id);
  const paid = ['success', 'refunded'].includes(p.status);
  if (!paid) {
    return { reversed: countCreated(await reverseAllForRef(ctx, id, ['amenity_payment', 'amenity_refund'], `Amenity payment ${p.status}`, day(p.updatedAt))) };
  }
  if (!(p.amount > 0)) return {}; // free bookings carry a zero-amount record
  // Cash collected at the desk is cash in hand; everything else lands in the bank.
  const money = p.method === 'cash' ? CODES.CASH : CODES.BANK;
  const held = p.kind === 'deposit' ? CODES.SECURITY_DEPOSITS : CODES.AMENITY_INCOME;
  const what = p.kind === 'deposit' ? 'deposit' : 'fee';
  let posted = 0;
  const main = await postEntry(ctx, {
    date: day(p.paidAt || p.createdAt),
    narration: `Amenity ${what}${p.receiptNumber ? ` ${p.receiptNumber}` : ''}`,
    reference: p.reference || p.providerPaymentId || p.receiptNumber,
    sourceType: 'amenity_payment',
    sourceId: id,
    lines: [
      { accountCode: money, debit: p.amount, unit: p.unit },
      { accountCode: held, credit: p.amount, unit: p.unit },
    ],
  });
  if (main.created) posted += 1;
  if (main.reversedBy) return { posted };

  const target = Math.min(p.amount, p.status === 'refunded' ? p.refundedAmount || p.amount : p.refundedAmount || 0);
  const refunds = await liveEntries(ctx.societyId, id, ['amenity_refund']);
  const delta = target - netOn(refunds, money, 'credit');
  if (delta) {
    const n = await JournalEntry.countDocuments({ society: ctx.societyId, sourceRef: id, sourceType: 'amenity_refund' });
    const amount = Math.abs(delta);
    const entry = await postEntry(ctx, {
      date: day(p.refundedAt || p.updatedAt),
      narration: `Amenity ${what} refund${p.receiptNumber ? ` ${p.receiptNumber}` : ''}`,
      reference: p.refundReference || p.reference,
      sourceType: 'amenity_refund',
      sourceId: `${id}:refund:${n + 1}`,
      sourceRef: id,
      lines: delta > 0
        ? [{ accountCode: held, debit: amount, unit: p.unit }, { accountCode: money, credit: amount, unit: p.unit }]
        : [{ accountCode: money, debit: amount, unit: p.unit }, { accountCode: held, credit: amount, unit: p.unit }],
    });
    if (entry.created) posted += 1;
  }
  return { posted };
}

async function syncPayslip(ctx, s) {
  const id = String(s._id);
  if (s.status !== 'paid') {
    return { reversed: countCreated(await reverseAllForRef(ctx, id, ['payslip'], `Payslip ${s.status}`, day(s.updatedAt))) };
  }
  if (!(s.net > 0)) return {};
  const entry = await postEntry(ctx, {
    date: day(s.paidAt || s.updatedAt),
    narration: [`Salary ${s.period || ''}`.trim(), s.name, s.number].filter(Boolean).join(' · '),
    reference: s.reference || s.number,
    sourceType: 'payslip',
    sourceId: id,
    lines: [
      { accountCode: CODES.SALARIES, debit: s.net },
      { accountCode: s.method === 'cash' ? CODES.CASH : CODES.BANK, credit: s.net },
    ],
  });
  return { posted: entry.created ? 1 : 0 };
}

async function syncVendorBill(ctx, b) {
  if (b.status === 'cancelled') return { reversed: (await reverseVendorBill(ctx, b, b.cancelReason, day(b.cancelledAt)))?.created ? 1 : 0 };
  return { posted: (await postVendorBill(ctx, b)).created ? 1 : 0 };
}

async function syncVendorPayment(ctx, p) {
  if (p.status === 'cancelled') return { reversed: (await reverseVendorPayment(ctx, p, p.cancelReason, day(p.cancelledAt)))?.created ? 1 : 0 };
  return { posted: (await postVendorPayment(ctx, p)).created ? 1 : 0 };
}

// ---------- driver ----------

// changeFields: timestamps that mark a change; updatedAt alone can miss raw/pipeline updates made elsewhere.
async function runSource(ctx, source, Model, handler, { full, changeFields = [] }) {
  const state = await SyncState.findOne({ society: ctx.societyId, source }).lean();
  const startedAt = new Date();
  const filter = { society: ctx.societyId };
  if (!full && state?.cursor) {
    const since = new Date(state.cursor.getTime() - OVERLAP_MS);
    filter.$or = ['updatedAt', ...changeFields].map((f) => ({ [f]: { $gte: since } }));
  }
  const result = { checked: 0, posted: 0, reversed: 0, errors: 0 };
  // No sort needed (the next cursor is this run's start time), which avoids in-memory sorts on
  // collections we do not own indexes for.
  const cursor = Model.find(filter).lean().cursor({ batchSize: 200 });
  for await (const doc of cursor) {
    result.checked += 1;
    try {
      const r = tally(await handler(doc));
      result.posted += r.posted;
      result.reversed += r.reversed;
    } catch (err) {
      result.errors += 1;
      if (result.errors <= 5) logger.error({ err: err.message, source, id: String(doc._id) }, 'accounting sync failed for a document');
      if (!result.firstError) result.firstError = `${String(doc._id)}: ${err.message}`;
    }
  }
  // On errors keep the old cursor so the failed documents are retried next time.
  const cursorAt = result.errors ? state?.cursor ?? null : startedAt;
  await SyncState.updateOne(
    { society: ctx.societyId, source },
    { $set: { cursor: cursorAt, lastRunAt: new Date(), lastResult: result } },
    { upsert: true },
  );
  return result;
}

export async function syncSociety(ctx, { full = false } = {}) {
  await ensureChart(ctx.societyId);
  const accounts = await accountsByCode(ctx.societyId);
  const sources = [
    ['bills', Bill, (d) => syncBill(ctx, d, accounts), ['createdAt', 'lateFeeAt']],
    ['payments', Payment, (d) => syncPayment(ctx, d), ['createdAt', 'paidAt', 'bouncedAt']],
    ['adjustments', await optionalModel('Adjustment'), (d) => syncAdjustment(ctx, d), ['createdAt', 'approvedAt']],
    ['amenityPayments', await optionalModel('AmenityPayment'), (d) => syncAmenityPayment(ctx, d), ['createdAt', 'paidAt', 'refundedAt']],
    ['payslips', await optionalModel('Payslip'), (d) => syncPayslip(ctx, d), ['createdAt', 'paidAt']],
    ['vendorBills', VendorBill, (d) => syncVendorBill(ctx, d), ['createdAt', 'cancelledAt']],
    ['vendorPayments', VendorPayment, (d) => syncVendorPayment(ctx, d), ['createdAt', 'cancelledAt']],
  ];
  const out = {};
  for (const [source, Model, handler, changeFields] of sources) {
    if (!Model) {
      out[source] = { skipped: 'not available' };
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    out[source] = await runSource(ctx, source, Model, handler, { full, changeFields });
  }
  return out;
}

export const syncStatus = (ctx) => SyncState.find({ society: ctx.societyId }).select('source cursor lastRunAt lastResult').lean();

const systemCtx = (societyId) => ({ societyId, userId: null, role: ROLES.ADMIN, unitId: null, ip: 'scheduler' });

// Scheduled job: incremental sync for every active society (full: re-check every document).
export async function syncAllSocieties({ full = false } = {}) {
  const societies = await Society.find({ active: true }).select('_id').lean();
  let posted = 0;
  let reversed = 0;
  let errors = 0;
  for (const s of societies) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await syncSociety(systemCtx(s._id), { full });
      for (const v of Object.values(r)) {
        posted += v.posted || 0;
        reversed += v.reversed || 0;
        errors += v.errors || 0;
      }
    } catch (err) {
      errors += 1;
      logger.error({ err, society: String(s._id) }, 'accounting sync failed for society');
    }
  }
  return { societies: societies.length, posted, reversed, errors };
}
