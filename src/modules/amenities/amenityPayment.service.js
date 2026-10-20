import AmenityPayment from './amenityPayment.model.js';
import Bill from '../billing/bill.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import logger from '../../common/utils/logger.js';
import { getGateway } from '../paymentSettings/paymentSettings.service.js';

// Gateway order covering one or more charges (e.g. fee + deposit). Earlier unpaid orders for the
// same booking/pass are marked failed so only the latest checkout can settle it.
export async function openOrder(ctx, { booking, pass, amenity, unit, charges, receipt }) {
  const amount = charges.reduce((s, c) => s + c.amount, 0);
  if (amount <= 0) throw ApiError.badRequest('Nothing to pay');
  const ref = booking ? { booking } : { pass };
  await AmenityPayment.updateMany({ society: ctx.societyId, ...ref, status: 'created' }, { status: 'failed', notes: 'Superseded by a newer checkout' });
  const provider = await getGateway(ctx.societyId);
  const order = await provider.createOrder({ amount, receipt, notes: { kind: booking ? 'amenity_booking' : 'amenity_pass', id: String(booking || pass) } });
  await AmenityPayment.insertMany(
    charges
      .filter((c) => c.amount > 0)
      .map((c) => ({
        society: ctx.societyId,
        unit,
        user: ctx.userId,
        ...ref,
        amenity,
        kind: c.kind,
        amount: c.amount,
        status: 'created',
        method: 'online',
        provider: provider.name,
        providerOrderId: order.orderId,
      })),
  );
  return { ...order, provider: provider.name, breakdown: charges };
}

// Verifies the gateway signature and marks every charge of the order paid. Returns the records.
// `trusted`: the provider webhook already proved the capture, so there is no checkout signature.
// Only one caller wins the update, so a checkout verify racing the webhook is applied once.
export async function settleOrder(ctx, { orderId, paymentId, signature }, { trusted = false } = {}) {
  const records = await AmenityPayment.find({ society: ctx.societyId, providerOrderId: orderId, user: ctx.userId });
  if (!records.length) throw ApiError.notFound('Order not found');
  if (records.every((r) => r.status === 'success')) return { records, alreadyPaid: true };
  // A captured payment is real money even if a bad checkout signature marked the order failed.
  if (records.some((r) => r.status !== 'created' && !(trusted && r.status === 'failed'))) throw ApiError.conflict('This order can no longer be paid');
  if (!trusted && !(await (await getGateway(ctx.societyId, { purpose: 'settle' })).verify({ orderId, paymentId, signature }))) {
    await AmenityPayment.updateMany({ _id: { $in: records.map((r) => r._id) } }, { status: 'failed' });
    throw ApiError.badRequest('Payment verification failed');
  }
  const ids = records.map((r) => r._id);
  const res = await AmenityPayment.updateMany(
    { _id: { $in: ids }, status: { $in: trusted ? ['created', 'failed'] : ['created'] } },
    { status: 'success', providerPaymentId: paymentId, paidAt: new Date() },
  );
  return { records: await AmenityPayment.find({ _id: { $in: ids } }), alreadyPaid: res.modifiedCount === 0 };
}

// Desk payment recorded by a manager.
export function recordOffline(ctx, { booking, pass, amenity, unit, user, charges, method, reference }) {
  const paidAt = new Date();
  return AmenityPayment.insertMany(
    charges
      .filter((c) => c.amount > 0)
      .map((c) => ({
        society: ctx.societyId,
        unit,
        user,
        booking,
        pass,
        amenity,
        kind: c.kind,
        amount: c.amount,
        status: 'success',
        method,
        provider: 'offline',
        reference,
        paidAt,
        recordedBy: ctx.userId,
      })),
  );
}

// Online refunds go back through the account that took the money (the society's own gateway, or the
// platform account for Route / legacy), resolved by getGateway like every other resident payment.
async function gatewayRefund(payment, amount) {
  if (payment.provider === 'offline') return null; // cash/UPI handed back by the office
  if (payment.provider !== 'mock' && payment.provider !== 'razorpay') throw ApiError.badRequest(`Refunds are not supported for provider ${payment.provider}`);
  const gateway = await getGateway(payment.society, { purpose: 'settle' });
  try {
    return (await gateway.refund({ paymentId: payment.providerPaymentId, amount, notes: { amenityPayment: String(payment._id) } })).refundId;
  } catch (err) {
    logger.error({ err: err.message, payment: String(payment._id) }, 'gateway refund failed');
    throw err;
  }
}

// Refunds up to `amount` of the given kind's successful payments for a booking/pass. Returns the refunded total.
export async function refund(ctx, ref, kind, amount) {
  if (amount <= 0) return 0;
  const payments = await AmenityPayment.find({ society: ctx.societyId, ...ref, kind, status: { $in: ['success', 'refunded'] } }).sort({ paidAt: 1 });
  let left = amount;
  for (const p of payments) {
    const available = p.amount - p.refundedAmount;
    if (left <= 0 || available <= 0) continue;
    const part = Math.min(available, left);
    // eslint-disable-next-line no-await-in-loop
    const refundId = await gatewayRefund(p, part);
    p.refundedAmount += part;
    p.status = 'refunded';
    p.refundedAt = new Date();
    if (refundId) p.refundIds.push(refundId);
    // eslint-disable-next-line no-await-in-loop
    await p.save();
    left -= part;
  }
  return amount - left;
}

export async function paidTotal(societyId, ref, kind) {
  const rows = await AmenityPayment.find({ society: societyId, ...ref, kind, status: { $in: ['success', 'refunded'] } }).select('amount refundedAmount').lean();
  return rows.reduce((s, r) => s + r.amount - r.refundedAmount, 0);
}

// ---------- defaulter restriction ----------
// The switch is the finance settings' restrictAmenityForDefaulters (financeSettings module). It is loaded
// lazily so amenities keep working if that module is missing; a flag on Society.settings is the fallback.
export async function blocksDefaulters(societyId) {
  try {
    const finance = await import('../financeSettings/financeSettings.service.js');
    if (typeof finance.forSociety === 'function') {
      const settings = await finance.forSociety(societyId);
      if (settings?.restrictAmenityForDefaulters) return true;
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'finance settings unavailable, using society settings');
  }
  const s = await Society.findById(societyId).select('settings').lean();
  const st = s?.settings || {};
  return Boolean(st.finance?.restrictAmenityForDefaulters ?? st.finance?.blockDefaulters ?? st.blockDefaulters ?? false);
}

// Prefer the billing module's isDefaulter() when it exists; otherwise any overdue unpaid/partial bill counts.
export async function isDefaulter(societyId, unitId) {
  if (!unitId) return false;
  try {
    const billing = await import('../billing/billing.service.js');
    if (typeof billing.isDefaulter === 'function') return Boolean(await billing.isDefaulter(societyId, unitId));
  } catch (err) {
    logger.warn({ err: err.message }, 'billing.isDefaulter unavailable, using local check');
  }
  return Boolean(await Bill.exists({ society: societyId, unit: unitId, status: { $in: ['unpaid', 'partial'] }, dueDate: { $lt: new Date() } }));
}

export async function assertNotBlocked(ctx) {
  if (!ctx.unitId) return;
  if ((await blocksDefaulters(ctx.societyId)) && (await isDefaulter(ctx.societyId, ctx.unitId))) {
    throw new ApiError(403, 'DUES_PENDING', 'Amenity bookings are paused for your home until overdue maintenance dues are cleared');
  }
}
