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
  const [settings, mandate, pending] = await Promise.all([
    financeSettings.forSociety(ctx.societyId),
    Mandate.findOne({ society: ctx.societyId, unit: ctx.unitId, status: 'active' }).select(PUBLIC).populate(POPULATE).lean(),
    // authorised by the resident, waiting for the bank
    Mandate.findOne({ society: ctx.societyId, unit: ctx.unitId, status: 'pending', authPaymentId: { $type: 'string' } }).select(PUBLIC).sort({ createdAt: -1 }).lean(),
  ]);
  return { enabled: settings.autopayEnabled, provider: provider.name, mandate, pending };
}

async function assertEnabled(ctx) {
  if (!ctx.unitId) throw ApiError.badRequest('Open your home to set up autopay');
  const settings = await financeSettings.forSociety(ctx.societyId);
  if (!settings.autopayEnabled) throw ApiError.conflict('Autopay is not enabled for this society');
}

// Changes the limit of the home's mandate. New mandates are set up with start() + confirm(); the mock
// provider also accepts a direct opt-in here (dev and tests).
export async function optIn(ctx, { maxAmount, method = 'upi' }) {
  await assertEnabled(ctx);
  const existing = await Mandate.findOne({ society: ctx.societyId, unit: ctx.unitId, status: 'active' });
  if (existing) {
    if (existing.authorisedMax && maxAmount > existing.authorisedMax) {
      throw ApiError.badRequest(`Your bank authorised up to ${money(existing.authorisedMax)}. Set up autopay again to raise the limit.`);
    }
    existing.maxAmount = maxAmount;
    if (existing.provider === 'mock') existing.method = method;
    await existing.save();
    audit.record(ctx, 'autopay.updated', 'AutopayMandate', existing._id, { maxAmount });
    return Mandate.findById(existing._id).select(PUBLIC).populate(POPULATE).lean();
  }
  const token = await provider.registerMandate({ maxAmount, method });
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
  const m = await Mandate.findOneAndUpdate(filter, { status: 'cancelled', cancelledAt: new Date() }, { returnDocument: 'after' }).lean();
  if (!m) throw ApiError.notFound('No active autopay mandate');
  revokeAtBank(m);
  audit.record(ctx, 'autopay.cancelled', 'AutopayMandate', m._id);
  const { tokenId: _t, customerId: _c, ...rest } = m;
  return rest;
}

// Stops the bank honouring further debits. Best effort: the mandate is already off on our side.
function revokeAtBank(m) {
  provider.cancelToken({ tokenId: m.tokenId, customerId: m.customerId }).catch((err) => logger.warn({ err, mandate: String(m._id) }, 'could not cancel the mandate token'));
}

// ---------- mandate sign-up (authorised once in the provider's checkout) ----------

const systemCtx = (m, ip) => ({ societyId: m.society, userId: m.user, role: ROLES.RESIDENT, unitId: m.unit, ip });

// Step 1: creates the authorisation order. The client opens checkout with it, then calls confirm().
export async function start(ctx, { maxAmount, method = 'upi' }) {
  await assertEnabled(ctx);
  const user = await User.findById(ctx.userId).select('name email phone').lean();
  const order = await provider.startMandate({ maxAmount, method, user, receipt: `MANDATE-${Date.now()}` });
  // Abandoned sign-ups of this home are dropped; one authorised and waiting for the bank is kept.
  await Mandate.deleteMany({ society: ctx.societyId, unit: ctx.unitId, status: 'pending', authPaymentId: { $exists: false } });
  const m = await Mandate.create({
    society: ctx.societyId,
    unit: ctx.unitId,
    user: ctx.userId,
    method,
    maxAmount,
    authorisedMax: maxAmount,
    provider: provider.name,
    status: 'pending',
    providerOrderId: order.orderId,
    customerId: order.customerId,
    authAmount: order.amount,
  });
  return { ...order, provider: provider.name, mandate: m._id, method, maxAmount, name: user?.name, email: user?.email, contact: user?.phone };
}

// Step 2: the checkout handler's response. Idempotent; the webhook may have finished it already.
export async function confirm(ctx, { orderId, paymentId, signature }) {
  const m = await Mandate.findOne({ society: ctx.societyId, unit: ctx.unitId, providerOrderId: orderId });
  if (!m) throw ApiError.notFound('Autopay sign-up not found');
  if (m.status === 'pending' && !m.authPaymentId) {
    const r = await provider.confirmMandate({ orderId, paymentId, signature, customerId: m.customerId });
    if (r.status === 'failed' && !r.tokenId) throw ApiError.badRequest(r.error || 'Mandate authorisation failed');
    await finishSignup(m, paymentId, r, ctx.ip);
  }
  return Mandate.findById(m._id).select(PUBLIC).populate(POPULATE).lean();
}

async function finishSignup(m, paymentId, r, ip) {
  // Claim the sign-up so a client retry and the webhook can't both credit the authorisation debit.
  const claimed = await Mandate.findOneAndUpdate(
    { _id: m._id, status: 'pending', authPaymentId: { $exists: false } },
    { authPaymentId: paymentId, ...(r.tokenId ? { tokenId: r.tokenId } : {}), customerId: r.customerId || m.customerId },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) return;
  const ctx = systemCtx(claimed, ip);
  const auth = r.authAmount ?? claimed.authAmount;
  if (auth > 0) await creditAuthorisation(ctx, claimed, paymentId, auth);
  if (r.status === 'failed') {
    await rejected(claimed, r.error || 'The bank rejected the mandate', 'failed');
    return;
  }
  if (r.status === 'active') {
    await activate(claimed);
    return;
  }
  audit.record(ctx, 'autopay.authorised', 'AutopayMandate', claimed._id, { maxAmount: claimed.maxAmount, method: claimed.method });
  await notifyUnit(claimed.society, claimed.unit, {
    type: 'bill',
    title: 'Autopay is waiting for your bank',
    body: 'Your bank is approving the mandate. This usually takes 2–3 working days; we will tell you when it is on.',
    link: '/billing',
    channels: ['inapp', 'push'],
  });
}

// The ₹1 UPI authorisation debit is real money, so it is held as advance credit for the home.
async function creditAuthorisation(ctx, m, paymentId, amount) {
  try {
    const payment = await Payment.create({
      society: m.society,
      unit: m.unit,
      purpose: 'advance',
      amount,
      method: 'online',
      provider: m.provider,
      providerOrderId: m.providerOrderId,
      providerPaymentId: paymentId,
      status: 'created',
      paidBy: m.user,
      paidAt: new Date(),
      notes: 'Autopay authorisation',
    });
    await settlePayment(ctx, payment, null, { allowExcess: true });
  } catch (err) {
    logger.error({ err, mandate: String(m._id) }, 'could not credit the autopay authorisation');
  }
}

// The bank confirmed the mandate: it replaces any earlier live mandate of the home.
async function activate(m) {
  const old = await Mandate.find({ society: m.society, unit: m.unit, status: 'active', _id: { $ne: m._id } }).lean();
  if (old.length) {
    await Mandate.updateMany({ _id: { $in: old.map((o) => o._id) } }, { status: 'cancelled', cancelledAt: new Date(), lastError: 'Replaced by a new mandate' });
    old.forEach(revokeAtBank);
  }
  const res = await Mandate.updateOne({ _id: m._id, status: 'pending' }, { status: 'active', confirmedAt: new Date(), failures: 0 });
  if (!res.modifiedCount) return;
  audit.record(systemCtx(m), 'autopay.enabled', 'AutopayMandate', m._id, { maxAmount: m.maxAmount, method: m.method });
  await notifyUnit(m.society, m.unit, {
    type: 'bill',
    title: 'Autopay is on',
    body: `New bills up to ${money(m.maxAmount)} will be paid automatically.`,
    link: '/billing',
    channels: ['inapp', 'push'],
  });
}

async function rejected(m, reason, status = 'cancelled') {
  await Mandate.updateOne({ _id: m._id }, { status, cancelledAt: new Date(), lastError: reason });
  await notifyUnit(m.society, m.unit, {
    type: 'bill',
    title: status === 'failed' ? 'Autopay was not set up' : 'Autopay was switched off',
    body: `${reason}. Please pay bills manually or set up autopay again.`,
    link: '/billing',
    channels: ['inapp', 'push', 'email'],
  });
}

// ---------- provider webhook events ----------

// A mandate's authorisation payment was captured (the resident may have closed the app before
// confirm() ran). Returns false when the order is not a mandate sign-up.
export async function onAuthorisationCaptured({ orderId, paymentId }) {
  const m = await Mandate.findOne({ providerOrderId: orderId });
  if (!m) return false;
  if (m.status === 'pending' && !m.authPaymentId) {
    const r = await provider.tokenForPayment(paymentId, m.customerId);
    await finishSignup(m, paymentId, r, 'webhook');
  }
  return true;
}

// token.confirmed / token.rejected / token.cancelled / token.paused.
export async function onTokenEvent(event, tokenId) {
  if (!tokenId) return;
  const list = await Mandate.find({ tokenId, status: { $in: ['pending', 'active'] } }).lean();
  for (const m of list) {
    if (event === 'token.confirmed') {
      // eslint-disable-next-line no-await-in-loop
      if (m.status === 'pending') await activate(m);
    } else if (event === 'token.rejected') {
      // eslint-disable-next-line no-await-in-loop
      await rejected(m, 'The bank rejected the mandate', m.status === 'pending' ? 'failed' : 'cancelled');
    } else if (event === 'token.cancelled' || event === 'token.paused') {
      // eslint-disable-next-line no-await-in-loop
      await rejected(m, event === 'token.paused' ? 'The mandate was paused at your bank' : 'The mandate was cancelled at your bank');
    }
  }
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

// Applies the provider's final answer to a pending recurring debit (reconcile job or webhook).
export async function resolveCharge(p, r, ip = 'scheduler') {
  if (p.status !== 'created') return 'done';
  const ctx = { societyId: p.society, userId: null, role: ROLES.ADMIN, unitId: null, ip };
  const bill = p.bill ? await Bill.findById(p.bill).lean() : null;
  if (r.status === 'captured') {
    await settlePayment(ctx, p, bill, { allowExcess: true });
    await Mandate.updateOne({ _id: p.mandate }, { lastResult: 'success', failures: 0, $unset: { lastError: 1 } });
    return 'settled';
  }
  if (r.status === 'failed') {
    const res = await Payment.updateOne({ _id: p._id, status: 'created', settling: { $ne: true } }, { status: 'failed', notes: r.error });
    if (!res.modifiedCount) return 'done';
    const mandate = await Mandate.findById(p.mandate).lean();
    if (mandate && bill) await failed(ctx, mandate, bill, r.error || 'Payment failed');
    return 'failed';
  }
  return 'pending';
}

// Webhook: a recurring debit was captured or failed. Returns false if the order isn't an autopay charge.
export async function onChargeEvent({ orderId, status, error }) {
  const p = await Payment.findOne({ providerOrderId: orderId, method: 'autopay' });
  if (!p) return false;
  await resolveCharge(p, { status, error }, 'webhook');
  return true;
}

// Scheduler: confirms recurring debits the provider settles asynchronously (Razorpay).
export async function reconcilePending() {
  const pending = await Payment.find({ method: 'autopay', status: 'created', providerPaymentId: { $type: 'string' }, createdAt: { $lt: new Date(Date.now() - 60 * 1000) } }).limit(200);
  let settled = 0;
  let failedCount = 0;
  for (const p of pending) {
    // eslint-disable-next-line no-await-in-loop
    const r = await provider.fetchPayment(p.providerPaymentId).catch(() => ({ status: 'pending' }));
    // eslint-disable-next-line no-await-in-loop
    const outcome = await resolveCharge(p, r).catch((err) => logger.warn({ err, payment: String(p._id) }, 'autopay reconcile failed'));
    if (outcome === 'settled') settled += 1;
    else if (outcome === 'failed') failedCount += 1;
  }
  return { checked: pending.length, settled, failed: failedCount };
}
