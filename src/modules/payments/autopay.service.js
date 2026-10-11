import Mandate from './mandate.model.js';
import Payment from './payment.model.js';
import Bill from '../billing/bill.model.js';
import User from '../users/user.model.js';
import ApiError from '../../common/errors/ApiError.js';
import logger from '../../common/utils/logger.js';
import { paginate } from '../../common/utils/pagination.js';
import { money } from '../../common/utils/money.js';
import { ROLES } from '../../common/constants/index.js';
import * as financeSettings from '../financeSettings/financeSettings.service.js';
import { notifyUnit } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';
import { provider } from './providers.js';
import { settlePayment } from './payments.service.js';

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
const PUBLIC = '-tokenId -customerId';
const POPULATE = [
  { path: 'unit', select: 'label' },
  { path: 'user', select: 'name email' },
];
// After this many consecutive failures the mandate is cancelled so the bank is not hit every month.
const MAX_FAILURES = 3;

export async function mine(ctx) {
  const [settings, mandate] = await Promise.all([
    financeSettings.forSociety(ctx.societyId),
    Mandate.findOne({ society: ctx.societyId, unit: ctx.unitId, status: 'active' }).select(PUBLIC).populate(POPULATE).lean(),
  ]);
  return { enabled: settings.autopayEnabled, provider: provider.name, mandate };
}

// Resident opts in (or changes the limit). With Razorpay the mandate must already be authorised in
// Checkout and its tokenId/customerId sent here; the mock provider issues a token directly.
export async function optIn(ctx, { maxAmount, method = 'upi', tokenId, customerId }) {
  if (!ctx.unitId) throw ApiError.badRequest('Open your home to set up autopay');
  const settings = await financeSettings.forSociety(ctx.societyId);
  if (!settings.autopayEnabled) throw ApiError.conflict('Autopay is not enabled for this society');
  const existing = await Mandate.findOne({ society: ctx.societyId, unit: ctx.unitId, status: 'active' });
  if (existing) {
    existing.maxAmount = maxAmount;
    existing.method = method;
    if (tokenId && customerId) Object.assign(existing, { tokenId, customerId, user: ctx.userId, failures: 0 });
    await existing.save();
    audit.record(ctx, 'autopay.updated', 'AutopayMandate', existing._id, { maxAmount });
    return Mandate.findById(existing._id).select(PUBLIC).populate(POPULATE).lean();
  }
  const token = await provider.registerMandate({ maxAmount, method, tokenId, customerId });
  try {
    const m = await Mandate.create({ society: ctx.societyId, unit: ctx.unitId, user: ctx.userId, method, maxAmount, provider: provider.name, ...token });
    audit.record(ctx, 'autopay.enabled', 'AutopayMandate', m._id, { maxAmount, method });
    return Mandate.findById(m._id).select(PUBLIC).populate(POPULATE).lean();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('Autopay is already set up for this home');
    throw err;
  }
}

export async function cancel(ctx, id) {
  const filter = { society: ctx.societyId, status: 'active' };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  if (id) filter._id = id;
  const m = await Mandate.findOneAndUpdate(filter, { status: 'cancelled', cancelledAt: new Date() }, { returnDocument: 'after' }).select(PUBLIC).lean();
  if (!m) throw ApiError.notFound('No active autopay mandate');
  audit.record(ctx, 'autopay.cancelled', 'AutopayMandate', m._id);
  return m;
}

export function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.status) filter.status = filters.status;
  return paginate(Mandate, filter, pagination, { sort: { createdAt: -1 }, populate: POPULATE, select: PUBLIC });
}

async function failed(ctx, mandate, bill, error) {
  const failures = (mandate.failures || 0) + 1;
  const stop = failures >= MAX_FAILURES;
  await Mandate.updateOne({ _id: mandate._id }, { lastResult: 'failed', lastError: error, lastChargedAt: new Date(), failures, ...(stop ? { status: 'cancelled', cancelledAt: new Date() } : {}) });
  await notifyUnit(ctx.societyId, mandate.unit, {
    type: 'bill',
    title: `Autopay failed for ${bill.billNumber}`,
    body: `${error}. Please pay ${money(bill.total - bill.paid)} manually.${stop ? ' Autopay was switched off after repeated failures.' : ''}`,
    link: '/billing',
    channels: ['inapp', 'push', 'email'],
  });
}

// Charges freshly generated bills of units with an active mandate. Bills above the mandate limit are
// left for manual payment (the household is told). Returns counts for the generate response.
export async function chargeBills(ctx, bills) {
  const mandates = new Map(
    (await Mandate.find({ society: ctx.societyId, unit: { $in: bills.map((b) => b.unit) }, status: 'active' }).lean()).map((m) => [String(m.unit), m]),
  );
  const out = { charged: 0, pending: 0, failed: 0, skipped: 0 };
  for (const b of bills) {
    const mandate = mandates.get(String(b.unit));
    if (!mandate) continue;
    // eslint-disable-next-line no-await-in-loop
    const bill = await Bill.findById(b._id).lean();
    const due = bill.total - bill.paid;
    if (due <= 0 || !['unpaid', 'partial'].includes(bill.status)) continue;
    if (due > mandate.maxAmount) {
      out.skipped += 1;
      // eslint-disable-next-line no-await-in-loop
      await Mandate.updateOne({ _id: mandate._id }, { lastResult: 'skipped', lastError: `Bill ${money(due)} is above the autopay limit ${money(mandate.maxAmount)}` });
      // eslint-disable-next-line no-await-in-loop
      await notifyUnit(ctx.societyId, b.unit, { type: 'bill', title: `Autopay skipped for ${bill.billNumber}`, body: `${money(due)} is above your autopay limit of ${money(mandate.maxAmount)}. Please pay manually.`, link: '/billing', channels: ['inapp', 'push'] });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const user = await User.findById(mandate.user).select('email phone').lean();
      // eslint-disable-next-line no-await-in-loop
      const r = await provider.chargeRecurring({ amount: due, tokenId: mandate.tokenId, customerId: mandate.customerId, receipt: bill.billNumber, notes: { bill: String(bill._id) }, email: user?.email, contact: user?.phone });
      if (r.status === 'failed') {
        out.failed += 1;
        // eslint-disable-next-line no-await-in-loop
        await Payment.create({ society: ctx.societyId, bill: bill._id, unit: bill.unit, amount: due, method: 'autopay', provider: provider.name, mandate: mandate._id, providerOrderId: r.orderId, status: 'failed', paidBy: mandate.user, notes: r.error });
        // eslint-disable-next-line no-await-in-loop
        await failed(ctx, mandate, bill, r.error || 'Payment declined');
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const payment = await Payment.create({ society: ctx.societyId, bill: bill._id, unit: bill.unit, amount: due, method: 'autopay', provider: provider.name, mandate: mandate._id, providerOrderId: r.orderId, providerPaymentId: r.paymentId, status: 'created', paidBy: mandate.user, paidAt: new Date() });
      if (r.status === 'captured') {
        // eslint-disable-next-line no-await-in-loop
        await settlePayment(ctx, payment, bill, { allowExcess: true });
        // eslint-disable-next-line no-await-in-loop
        await Mandate.updateOne({ _id: mandate._id }, { lastResult: 'success', lastChargedAt: new Date(), failures: 0, $unset: { lastError: 1 } });
        out.charged += 1;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await Mandate.updateOne({ _id: mandate._id }, { lastResult: 'pending', lastChargedAt: new Date() });
        out.pending += 1;
      }
    } catch (err) {
      logger.error({ err, bill: bill.billNumber }, 'autopay charge failed');
      out.failed += 1;
      // eslint-disable-next-line no-await-in-loop
      await failed(ctx, mandate, bill, 'Could not reach the payment provider');
    }
  }
  if (out.charged || out.failed || out.pending) audit.record(ctx, 'autopay.run', 'AutopayMandate', undefined, out);
  return out;
}

// Scheduler: confirms recurring debits the provider settles asynchronously (Razorpay).
export async function reconcilePending() {
  const pending = await Payment.find({ method: 'autopay', status: 'created', providerPaymentId: { $type: 'string' }, createdAt: { $lt: new Date(Date.now() - 60 * 1000) } }).limit(200);
  let settled = 0;
  let failedCount = 0;
  for (const p of pending) {
    const ctx = { societyId: p.society, userId: null, role: ROLES.ADMIN, unitId: null, ip: 'scheduler' };
    // eslint-disable-next-line no-await-in-loop
    const r = await provider.fetchPayment(p.providerPaymentId).catch(() => ({ status: 'pending' }));
    // eslint-disable-next-line no-await-in-loop
    const bill = p.bill ? await Bill.findById(p.bill).lean() : null;
    if (r.status === 'captured') {
      // eslint-disable-next-line no-await-in-loop
      await settlePayment(ctx, p, bill, { allowExcess: true });
      // eslint-disable-next-line no-await-in-loop
      await Mandate.updateOne({ _id: p.mandate }, { lastResult: 'success', failures: 0, $unset: { lastError: 1 } });
      settled += 1;
    } else if (r.status === 'failed') {
      p.status = 'failed';
      p.notes = r.error;
      // eslint-disable-next-line no-await-in-loop
      await p.save();
      // eslint-disable-next-line no-await-in-loop
      const mandate = await Mandate.findById(p.mandate).lean();
      // eslint-disable-next-line no-await-in-loop
      if (mandate && bill) await failed(ctx, mandate, bill, r.error || 'Payment failed');
      failedCount += 1;
    }
  }
  return { checked: pending.length, settled, failed: failedCount };
}
