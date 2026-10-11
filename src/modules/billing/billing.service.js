import mongoose from 'mongoose';
import Bill from './bill.model.js';
import Adjustment from './adjustment.model.js';
import Unit from '../units/unit.model.js';
import Society from '../society/society.model.js';
import Payment from '../payments/payment.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import logger from '../../common/utils/logger.js';
import { paginate } from '../../common/utils/pagination.js';
import { addDays } from '../../common/utils/dates.js';
import { money } from '../../common/utils/money.js';
import { ROLES } from '../../common/constants/index.js';
import { nextSeq } from '../counter/counter.service.js';
import { notifyUnit } from '../notifications/notifications.service.js';
import { sendEmailQuietly } from '../../integrations/email.js';
import * as audit from '../audit/audit.service.js';
import * as financeSettings from '../financeSettings/financeSettings.service.js';
import * as meters from '../meters/meters.service.js';
import { ACCOUNTS } from '../financeSettings/financeSettings.model.js';
import { OPEN, addPaid } from './billOps.js';
import { applyCreditToBill, creditBalance, creditBalances, markCharged, unbilledCharges } from './adjustments.service.js';
import { billPdf, taxSummary } from './documents.js';

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

export function buildLines(billing, unit, extraLines = []) {
  const lines = [];
  if (billing.fixedAmount > 0) lines.push({ head: 'Maintenance', amount: billing.fixedAmount });
  if (billing.perSqftRate > 0 && unit.areaSqft > 0) {
    lines.push({ head: `Maintenance (${unit.areaSqft} sq.ft)`, amount: Math.round(billing.perSqftRate * unit.areaSqft) });
  }
  for (const h of billing.chargeHeads || []) if (h.amount > 0) lines.push({ head: h.name, amount: h.amount });
  for (const l of extraLines) if (l.amount > 0) lines.push(l);
  return lines;
}

const pct = (r) => `${Number.isInteger(r) ? r : Number(r.toFixed(2))}%`;

// Full bill lines for one unit: charge heads (+ fund accounts), non-occupancy charge, metered utilities,
// unbilled cheque-bounce charges, one-time extras, then CGST/SGST lines grouped by rate.
// Each input line may carry `key` — the charge-head name used for account/GST mapping
// ("Maintenance (1000 sq.ft)" → "Maintenance", "Water (12 kL)" → "Water").
export function composeLines(billing, settings, unit, { extraLines = [], metered = [], bounceCharges = [] } = {}) {
  const base = buildLines(billing, unit).map((l) => ({ ...l, key: l.head.startsWith('Maintenance') ? 'Maintenance' : l.head, kind: 'charge' }));

  const nonOcc = settings.nonOccupancy || {};
  if (nonOcc.percent > 0 && (nonOcc.appliesTo || []).includes(unit.occupancy)) {
    const service = base.filter((l) => l.key === 'Maintenance').reduce((s, l) => s + l.amount, 0);
    const amount = Math.round((service * nonOcc.percent) / 100);
    if (amount > 0) base.push({ head: `Non-occupancy charges (${pct(nonOcc.percent)})`, key: 'Non-occupancy charges', amount, kind: 'non_occupancy' });
  }
  for (const m of metered) base.push({ head: m.head, key: m.key, amount: m.amount, kind: 'metered' });
  for (const c of bounceCharges) base.push({ head: 'Cheque bounce charge', key: 'Cheque bounce charge', amount: c.amount, kind: 'bounce_charge' });
  for (const l of extraLines) if (l.amount > 0) base.push({ head: l.head, key: l.head, amount: l.amount, kind: 'charge' });

  const subtotal = base.reduce((s, l) => s + l.amount, 0);
  const gstApplies = settings.gstEnabled && !(settings.gstExemptUpTo > 0 && subtotal <= settings.gstExemptUpTo);
  const lines = base.map(({ key, ...l }) => ({
    ...l,
    account: financeSettings.accountFor(settings, key, l.kind === 'bounce_charge' ? ACCOUNTS.OTHER_INCOME : ACCOUNTS.MAINTENANCE),
    ...(settings.gstEnabled ? { gstRate: gstApplies ? financeSettings.gstRateFor(settings, key) : 0 } : {}),
  }));

  if (gstApplies) {
    const byRate = new Map();
    for (const l of lines) if (l.gstRate > 0) byRate.set(l.gstRate, (byRate.get(l.gstRate) || 0) + l.amount);
    for (const [rate, taxable] of [...byRate].sort((a, b) => b[0] - a[0])) {
      const half = rate / 2;
      const tax = Math.round((taxable * half) / 100);
      if (tax <= 0) continue;
      lines.push({ head: `CGST ${pct(half)}`, amount: tax, account: ACCOUNTS.GST_PAYABLE, kind: 'gst' });
      lines.push({ head: `SGST ${pct(half)}`, amount: tax, account: ACCOUNTS.GST_PAYABLE, kind: 'gst' });
    }
  }
  return lines;
}

// Creates the period's bills. Besides the configured charges it adds GST, non-occupancy charges,
// metered utility consumption and unbilled bounce charges, then uses each unit's advance credit and
// charges autopay mandates. Units already billed for the period are skipped.
export async function generate(ctx, { period, dueDate, units: unitIds, extraLines, notes }) {
  const [society, settings] = await Promise.all([Society.findById(ctx.societyId).lean(), financeSettings.forSociety(ctx.societyId)]);
  const billing = society.settings.billing;
  const unitFilter = { society: ctx.societyId };
  if (unitIds?.length) unitFilter._id = { $in: unitIds };
  const units = await Unit.find(unitFilter).select('label areaSqft occupancy').lean();
  if (!units.length) throw ApiError.badRequest('No units found to bill');

  const already = new Set((await Bill.find({ society: ctx.societyId, period }).select('unit').lean()).map((b) => String(b.unit)));
  const due = dueDate || addDays(new Date(), billing.dueDays);
  const toBill = units.filter((u) => !already.has(String(u._id)));
  const ids = toBill.map((u) => u._id);
  const [metered, bounce] = await Promise.all([meters.meteredCharges(ctx.societyId, ids, period), unbilledCharges(ctx.societyId, ids)]);
  const gstin = settings.gstEnabled && settings.gstin ? settings.gstin : undefined;

  const docs = [];
  const chargesByUnit = new Map();
  let skippedZero = 0;
  for (const unit of toBill) {
    const key = String(unit._id);
    const lines = composeLines(billing, settings, unit, { extraLines, metered: metered.lines.get(key), bounceCharges: bounce.get(key) });
    const amount = lines.reduce((s, l) => s + l.amount, 0);
    if (amount <= 0) {
      skippedZero += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const seq = await nextSeq(ctx.societyId, `bill:${period}`);
    if (bounce.get(key)) chargesByUnit.set(key, bounce.get(key));
    docs.push({
      society: ctx.societyId,
      unit: unit._id,
      period,
      billNumber: `BILL-${period}-${String(seq).padStart(4, '0')}`,
      lines,
      amount,
      total: amount,
      dueDate: due,
      meters: metered.details.get(key),
      gstin,
      notes,
      generatedBy: ctx.userId,
    });
  }

  let inserted = [];
  if (docs.length) {
    try {
      inserted = await Bill.insertMany(docs, { ordered: false });
    } catch (err) {
      // A concurrent run billed some units first; carry on with the ones this run created.
      if (err.code !== 11000 && !err.writeErrors) throw err;
      inserted = err.insertedDocs || [];
    }
  }
  const created = inserted.map((b) => (b.toObject ? b.toObject() : b));
  await metered.commit(created.map((b) => b.unit));
  const charged = new Map();
  for (const b of created) for (const c of chargesByUnit.get(String(b.unit)) || []) charged.set(String(c._id), b._id);
  if (charged.size) await markCharged(ctx.societyId, [...charged.keys()], charged);

  // Advance credit first, so autopay and the notification use what is really still due.
  let creditUsed = 0;
  const credits = await creditBalances(ctx.societyId, created.map((b) => b.unit));
  for (const b of created) {
    if (!credits.get(String(b.unit))) continue;
    // eslint-disable-next-line no-await-in-loop
    const applied = await applyCreditToBill(ctx, b);
    b.paid += applied;
    creditUsed += applied;
  }

  await Promise.all(
    created.map((b) =>
      notifyUnit(ctx.societyId, b.unit, {
        type: 'bill',
        title: `Maintenance bill for ${period}`,
        body: b.total - b.paid > 0 ? `${money(b.total - b.paid)} due by ${due.toDateString()}${b.paid ? ` (advance of ${money(b.paid)} adjusted)` : ''}` : `${money(b.total)} fully adjusted from your advance`,
        link: '/billing',
        channels: ['inapp', 'push', 'whatsapp'],
      }),
    ),
  );

  let autopay;
  if (settings.autopayEnabled && created.some((b) => b.total > b.paid)) {
    // Imported lazily: the autopay service depends on payments, which depends on this module.
    const { chargeBills } = await import('../payments/autopay.service.js');
    autopay = await chargeBills(ctx, created.filter((b) => b.total > b.paid)).catch((err) => {
      logger.error({ err }, 'autopay run failed');
      return { error: err.message };
    });
  }

  audit.record(ctx, 'bill.generated', 'Bill', undefined, { period, created: created.length, creditUsed });
  return { period, created: created.length, alreadyBilled: already.size, skippedZero, creditApplied: creditUsed, ...(autopay ? { autopay } : {}) };
}

export function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  else if (filters.unit) filter.unit = filters.unit;
  if (filters.status) filter.status = filters.status;
  if (filters.period) filter.period = filters.period;
  if (filters.overdue) {
    filter.status = { $in: OPEN };
    filter.dueDate = { $lt: new Date() };
  }
  return paginate(Bill, filter, pagination, { sort: { period: -1, billNumber: 1 }, populate: { path: 'unit', select: 'label' } }).then((r) => ({
    ...r,
    items: r.items.map((b) => ({ ...b, balance: Math.max(0, b.total - b.paid) })),
  }));
}

async function findBill(ctx, id) {
  const filter = { _id: id, society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  const bill = await Bill.findOne(filter).populate('unit', 'label areaSqft').lean();
  if (!bill) throw ApiError.notFound('Bill not found');
  return bill;
}

export async function getById(ctx, id) {
  const bill = await findBill(ctx, id);
  const [payments, bounced, adjustments, credit] = await Promise.all([
    Payment.find({ society: ctx.societyId, bill: id, status: 'success' }).sort({ paidAt: 1 }).lean(),
    Payment.find({ society: ctx.societyId, bill: id, status: 'bounced' }).sort({ paidAt: 1 }).lean(),
    Adjustment.find({ society: ctx.societyId, bill: id, ...(isResident(ctx) ? { status: 'approved' } : {}) }).sort({ createdAt: 1 }).populate('requestedBy approvedBy', 'name').lean(),
    creditBalance(ctx.societyId, bill.unit._id),
  ]);
  const { taxable, exempt, cgst, sgst, gst } = taxSummary(bill);
  return { ...bill, balance: Math.max(0, bill.total - bill.paid), payments, bouncedPayments: bounced, adjustments, creditBalance: credit, tax: { taxable, exempt, cgst, sgst, gst } };
}

export async function cancel(ctx, id) {
  const bill = await Bill.findOne({ _id: id, society: ctx.societyId });
  if (!bill) throw ApiError.notFound('Bill not found');
  if (bill.paid > 0) throw ApiError.conflict('A bill with payments cannot be cancelled');
  if (bill.status === 'cancelled') throw ApiError.conflict('Bill is already cancelled');
  bill.status = 'cancelled';
  await bill.save();
  // Charges carried by this bill go on the next one instead.
  await Adjustment.updateMany({ society: ctx.societyId, bill: bill._id, type: 'bounce_charge' }, { $unset: { bill: 1 } });
  await meters.unbill(ctx.societyId, bill.meters);
  audit.record(ctx, 'bill.cancelled', 'Bill', bill._id, { billNumber: bill.billNumber });
  return bill.toObject();
}

// Applies the society's late fee once to every overdue open bill. Total stays amount + fee − waived.
export async function applyLateFees(ctx) {
  const society = await Society.findById(ctx.societyId).lean();
  const { lateFeeType, lateFeeValue } = society.settings.billing;
  if (lateFeeType === 'none' || !lateFeeValue) return { updated: 0 };
  const now = new Date();
  const overdue = await Bill.find({ society: ctx.societyId, status: { $in: OPEN }, dueDate: { $lt: now }, lateFee: 0 }).lean();
  const ops = overdue.map((b) => {
    const fee = lateFeeType === 'flat' ? Math.round(lateFeeValue) : Math.round((b.amount * lateFeeValue) / 100);
    return {
      updateOne: {
        filter: { _id: b._id, lateFee: 0 },
        update: [{ $set: { lateFee: fee, lateFeeAt: now, total: { $subtract: [{ $add: ['$amount', fee] }, { $ifNull: ['$waived', 0] }] } } }],
        updatePipeline: true,
      },
    };
  });
  if (ops.length) await Bill.bulkWrite(ops);
  audit.record(ctx, 'bill.late_fees_applied', 'Bill', undefined, { updated: ops.length });
  return { updated: ops.length };
}

// Atomically adds a payment to a bill, refusing overpayment. Returns the updated bill or null.
export function applyPayment(societyId, billId, amount, session) {
  return addPaid(societyId, billId, amount, { session });
}

// Overdue dues per unit, net of advance credit the unit holds. Units whose advance covers their
// overdue dues are not defaulters.
export async function defaulters(ctx) {
  const rows = await Bill.aggregate([
    { $match: { society: ctx.societyId, status: { $in: OPEN }, dueDate: { $lt: new Date() } } },
    { $group: { _id: '$unit', outstanding: { $sum: { $subtract: ['$total', '$paid'] } }, bills: { $sum: 1 }, oldestDue: { $min: '$dueDate' } } },
    { $sort: { outstanding: -1 } },
    { $lookup: { from: 'units', localField: '_id', foreignField: '_id', as: 'unit', pipeline: [{ $project: { label: 1 } }] } },
    { $unwind: '$unit' },
    { $project: { _id: 0, unit: 1, outstanding: 1, bills: 1, oldestDue: 1 } },
  ]);
  const credits = await creditBalances(ctx.societyId, rows.map((r) => r.unit._id));
  return rows
    .map((r) => {
      const advance = credits.get(String(r.unit._id)) || 0;
      return { ...r, advance, net: Math.max(0, r.outstanding - advance) };
    })
    .filter((r) => r.net > 0)
    .sort((a, b) => b.net - a.net);
}

// For other modules (e.g. amenities): does the unit have overdue dues not covered by its advance?
export async function isDefaulter(societyId, unitId) {
  if (!unitId) return false;
  const [row] = await Bill.aggregate([
    { $match: { society: oid(societyId), unit: oid(unitId), status: { $in: OPEN }, dueDate: { $lt: new Date() } } },
    { $group: { _id: null, due: { $sum: { $subtract: ['$total', '$paid'] } } } },
  ]);
  if (!row?.due) return false;
  return row.due > (await creditBalance(societyId, unitId));
}

// True when the society restricts amenity bookings for defaulters and this unit is one.
export async function amenityBookingBlocked(societyId, unitId) {
  const settings = await financeSettings.forSociety(societyId);
  return Boolean(settings.restrictAmenityForDefaulters) && isDefaulter(societyId, unitId);
}

export async function summary(ctx, period) {
  const match = { society: ctx.societyId, status: { $ne: 'cancelled' } };
  if (isResident(ctx)) match.unit = ctx.unitId;
  if (period) match.period = period;
  const [row] = await Bill.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        billed: { $sum: '$total' },
        collected: { $sum: '$paid' },
        bills: { $sum: 1 },
        paidBills: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
        overdue: { $sum: { $cond: [{ $and: [{ $in: ['$status', OPEN] }, { $lt: ['$dueDate', new Date()] }] }, { $subtract: ['$total', '$paid'] }, 0] } },
      },
    },
  ]);
  const s = row || { billed: 0, collected: 0, bills: 0, paidBills: 0, overdue: 0 };
  const out = { billed: s.billed, collected: s.collected, outstanding: s.billed - s.collected, overdue: s.overdue, bills: s.bills, paidBills: s.paidBills };
  if (isResident(ctx) && ctx.unitId) out.advance = await creditBalance(ctx.societyId, ctx.unitId);
  return out;
}

// ---------- documents ----------
async function billedToName(societyId, unitId) {
  const members = await Membership.find({ society: societyId, unit: unitId, role: ROLES.RESIDENT, status: 'active' }).populate('user', 'name').sort({ residentType: 1, createdAt: 1 }).lean();
  const owner = members.find((m) => m.residentType === 'owner') || members[0];
  return owner?.user?.name;
}

export async function billPdfBuffer(ctx, id) {
  const bill = await findBill(ctx, id);
  const [society, billedTo] = await Promise.all([Society.findById(ctx.societyId).select('name address city state pincode').lean(), billedToName(ctx.societyId, bill.unit._id)]);
  return { filename: `${bill.billNumber}.pdf`, buffer: await billPdf({ society, bill, unit: bill.unit, billedTo }) };
}

// "Email me this bill": sends the PDF to the signed-in user's own address.
export async function emailBill(ctx, id) {
  if (!ctx.user?.email) throw ApiError.badRequest('Add an email address to your profile first');
  const { filename, buffer } = await billPdfBuffer(ctx, id);
  const bill = await Bill.findById(id).select('billNumber period total paid dueDate').lean();
  sendEmailQuietly({
    to: ctx.user.email,
    subject: `Bill ${bill.billNumber}`,
    text: `Hi ${ctx.user.name},\n\nAttached is bill ${bill.billNumber} for ${bill.period}. Balance due: ${money(Math.max(0, bill.total - bill.paid))}.\n`,
    attachments: [{ filename, content: buffer, type: 'application/pdf' }],
  });
  audit.record(ctx, 'bill.emailed', 'Bill', id, { to: ctx.user.email });
  return { sent: true, to: ctx.user.email };
}
