import crypto from 'node:crypto';
import Payment from './payment.model.js';
import Bill from '../billing/bill.model.js';
import Unit from '../units/unit.model.js';
import Society from '../society/society.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import logger from '../../common/utils/logger.js';
import { paginate } from '../../common/utils/pagination.js';
import { withTransaction } from '../../common/utils/transaction.js';
import { money } from '../../common/utils/money.js';
import { ROLES } from '../../common/constants/index.js';
import { nextNumber } from '../counter/counter.service.js';
import { applyPayment } from '../billing/billing.service.js';
import { reversePaid } from '../billing/billOps.js';
import { addCredit, creditBalance, recordBounceCharge, reverseAdvance } from '../billing/adjustments.service.js';
import { receiptPdf } from '../billing/documents.js';
import * as financeSettings from '../financeSettings/financeSettings.service.js';
import { notifyUnit } from '../notifications/notifications.service.js';
import { sendEmailQuietly } from '../../integrations/email.js';
import { invalidate } from '../../realtime/socket.js';
import * as audit from '../audit/audit.service.js';
import { getGateway } from '../paymentSettings/paymentSettings.service.js';

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
const OPEN = ['unpaid', 'partial'];
const POPULATE = [
  { path: 'unit', select: 'label' },
  { path: 'bill', select: 'billNumber period' },
  { path: 'recordedBy', select: 'name' },
  { path: 'paidBy', select: 'name' },
];

async function openBill(ctx, billId) {
  const filter = { _id: billId, society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  const bill = await Bill.findOne(filter).lean();
  if (!bill) throw ApiError.notFound('Bill not found');
  if (!OPEN.includes(bill.status)) throw ApiError.conflict('Bill is {status}', { params: { status: bill.status } });
  return bill;
}

// Settles a received payment. Money goes to the bill (if any) up to its balance; with `allowExcess`
// the rest is held as advance credit instead of being refused. Advance-only payments have no bill.
// Issues the receipt, notifies and emails the household. Used by offline, online and autopay flows.
// Safe to call twice for one payment (checkout verify and the provider webhook): only one applies it.
export async function settlePayment(ctx, payment, bill, opts) {
  if (payment.isNew) return applySettlement(ctx, payment, bill, opts); // offline: saved only if it succeeds
  const claim = await Payment.updateOne({ _id: payment._id, status: { $in: ['created', 'failed'] }, settling: { $ne: true } }, { settling: true });
  if (!claim.modifiedCount) {
    // The other caller is recording it: wait briefly for its result.
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const current = await Payment.findById(payment._id).populate(POPULATE).lean();
      if (current?.status === 'success') return current;
      if (!current?.settling) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    throw ApiError.conflict('This payment is already being recorded');
  }
  try {
    return await applySettlement(ctx, payment, bill, opts);
  } finally {
    await Payment.updateOne({ _id: payment._id }, { $unset: { settling: 1 } });
  }
}

async function applySettlement(ctx, payment, bill, { allowExcess = false } = {}) {
  let applied = 0;
  let excess = 0;
  for (let attempt = 0; ; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const fresh = bill ? await Bill.findOne({ _id: bill._id, society: ctx.societyId }).select('total paid status').lean() : null;
    const balance = fresh && OPEN.includes(fresh.status) ? fresh.total - fresh.paid : 0;
    if (!allowExcess && payment.amount > balance) throw ApiError.conflict('Amount exceeds the outstanding balance');
    applied = Math.min(payment.amount, balance);
    excess = payment.amount - applied;
    // eslint-disable-next-line no-await-in-loop
    const done = await withTransaction(async (session) => {
      if (applied > 0 && !(await applyPayment(ctx.societyId, bill._id, applied, session))) return false; // bill changed: retry
      if (excess > 0) {
        await addCredit(ctx, { unit: payment.unit, type: 'advance', amount: excess, payment: payment._id, reason: bill ? `Excess of ${payment.method} payment held as advance` : 'Advance payment' }, session);
      }
      payment.appliedAmount = applied;
      payment.advanceAmount = excess;
      payment.purpose = bill ? 'bill' : 'advance';
      payment.status = 'success';
      await payment.save({ session });
      return true;
    });
    if (done) break;
    if (attempt >= 2) throw ApiError.conflict('The bill changed while recording the payment. Try again.');
  }
  payment.receiptNumber = await nextNumber(ctx.societyId, 'receipt', 'RCPT');
  await Payment.updateOne({ _id: payment._id }, { receiptNumber: payment.receiptNumber });

  const what = bill ? `for ${bill.billNumber}` : 'as advance';
  await notifyUnit(ctx.societyId, payment.unit, {
    type: 'bill',
    title: 'Payment received',
    body: `${money(payment.amount)} ${what} · ${payment.receiptNumber}${bill && excess ? ` (${money(excess)} kept as advance)` : ''}`,
    link: '/billing',
    channels: ['inapp', 'push', 'whatsapp'],
    waKind: 'receipt',
  });
  emailReceiptToHousehold(ctx.societyId, payment._id).catch((err) => logger.warn({ err: err.message }, 'receipt email failed'));
  audit.record(ctx, 'payment.recorded', 'Payment', payment._id, { bill: bill?.billNumber, amount: payment.amount, method: payment.method, advance: excess });
  invalidate(ctx.societyId, ['bills', 'payments', 'finance'], { unit: payment.unit });
  return Payment.findById(payment._id).populate(POPULATE).lean();
}

export async function recordOffline(ctx, data) {
  const bill = await openBill(ctx, data.bill);
  if (!data.excessAsAdvance && data.amount > bill.total - bill.paid) throw ApiError.badRequest('Amount exceeds the outstanding balance');
  const payment = new Payment({
    society: ctx.societyId,
    bill: bill._id,
    unit: bill.unit,
    amount: data.amount,
    method: data.method,
    reference: data.reference,
    notes: data.notes,
    paidAt: data.paidAt || new Date(),
    recordedBy: ctx.userId,
    status: 'created',
  });
  return settlePayment(ctx, payment, bill, { allowExcess: Boolean(data.excessAsAdvance) });
}

// Money received without a bill (e.g. a year in advance) → advance credit used on the next bills.
export async function recordAdvance(ctx, data) {
  const unit = await Unit.findOne({ _id: data.unit, society: ctx.societyId }).select('_id').lean();
  if (!unit) throw ApiError.notFound('Unit not found');
  const payment = new Payment({
    society: ctx.societyId,
    unit: unit._id,
    purpose: 'advance',
    amount: data.amount,
    method: data.method,
    reference: data.reference,
    notes: data.notes,
    paidAt: data.paidAt || new Date(),
    recordedBy: ctx.userId,
    status: 'created',
  });
  return settlePayment(ctx, payment, null, { allowExcess: true });
}

// Online flow: create order -> client pays with provider checkout -> verify signature.
export async function createOrder(ctx, billId) {
  const bill = await openBill(ctx, billId);
  const amount = bill.total - bill.paid;
  // The society's own gateway (or Route / legacy platform account): money goes to the society.
  const provider = await getGateway(ctx.societyId);
  const order = await provider.createOrder({ amount, receipt: bill.billNumber, notes: { bill: String(bill._id) } });
  await Payment.create({
    society: ctx.societyId,
    bill: bill._id,
    unit: bill.unit,
    amount,
    method: 'online',
    provider: provider.name,
    providerOrderId: order.orderId,
    status: 'created',
    paidBy: ctx.userId,
  });
  return { ...order, provider: provider.name, billNumber: bill.billNumber };
}

// Resident pays ahead online; the money becomes advance credit.
export async function createAdvanceOrder(ctx, amount) {
  if (!ctx.unitId) throw ApiError.badRequest('Open your home to pay');
  const provider = await getGateway(ctx.societyId);
  const order = await provider.createOrder({ amount, receipt: `ADV-${Date.now()}`, notes: { unit: String(ctx.unitId), purpose: 'advance' } });
  await Payment.create({
    society: ctx.societyId,
    unit: ctx.unitId,
    purpose: 'advance',
    amount,
    method: 'online',
    provider: provider.name,
    providerOrderId: order.orderId,
    status: 'created',
    paidBy: ctx.userId,
  });
  return { ...order, provider: provider.name, billNumber: 'Advance payment' };
}

export async function verifyOnline(ctx, { orderId, paymentId, signature }) {
  const payment = await Payment.findOne({ society: ctx.societyId, providerOrderId: orderId });
  if (!payment) throw ApiError.notFound('Order not found');
  if (payment.status === 'success') return Payment.findById(payment._id).populate(POPULATE).lean(); // idempotent
  const provider = await getGateway(ctx.societyId, { purpose: 'settle' });
  if (!(await provider.verify({ orderId, paymentId, signature }))) {
    payment.status = 'failed';
    await payment.save();
    throw ApiError.badRequest('Payment verification failed');
  }
  return captureOnline(ctx, payment, paymentId);
}

async function captureOnline(ctx, payment, paymentId) {
  payment.providerPaymentId = paymentId;
  payment.paidAt = new Date();
  await Payment.updateOne({ _id: payment._id }, { providerPaymentId: paymentId, paidAt: payment.paidAt });
  const bill = payment.bill ? await Bill.findById(payment.bill).lean() : null;
  // The money is already captured: if the bill was paid meanwhile (e.g. offline), keep the surplus as advance.
  return settlePayment(ctx, payment, bill, { allowExcess: true });
}

// Provider webhook: the order's payment was captured (the webhook body's signature is already checked).
// Covers residents who paid but closed the app before verify ran. Returns false for unknown orders.
// societyId: set for a society's own-gateway webhook, which may only settle that society's orders.
export async function captureByOrder({ orderId, paymentId, societyId }) {
  const payment = await Payment.findOne({ providerOrderId: orderId, method: 'online', ...(societyId ? { society: societyId } : {}) });
  if (!payment) return false;
  if (['created', 'failed'].includes(payment.status)) {
    const ctx = { societyId: payment.society, userId: payment.paidBy, role: ROLES.RESIDENT, unitId: payment.unit, ip: 'webhook' };
    await captureOnline(ctx, payment, paymentId);
  }
  return true;
}

// Dev-only helper standing in for the provider checkout: returns a valid mock payment id + signature,
// signed with the society's own (mock) account.
export async function mockSign(orderId, societyId) {
  const provider = await getGateway(societyId, { purpose: 'settle' });
  if (provider.name !== 'mock') throw ApiError.notFound();
  const paymentId = `mock_pay_${crypto.randomBytes(8).toString('hex')}`;
  return { orderId, paymentId, signature: provider.sign(orderId, paymentId) };
}

export function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId, status: filters.status || { $in: ['success', 'bounced'] } };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  else if (filters.unit) filter.unit = filters.unit;
  if (filters.method) filter.method = filters.method;
  if (filters.purpose) filter.purpose = filters.purpose === 'advance' ? 'advance' : { $ne: 'advance' };
  if (filters.from || filters.to) {
    filter.paidAt = {};
    if (filters.from) filter.paidAt.$gte = filters.from;
    if (filters.to) filter.paidAt.$lt = filters.to;
  }
  return paginate(Payment, filter, pagination, { sort: { paidAt: -1 }, populate: POPULATE });
}

async function findReceipt(ctx, id) {
  const filter = { _id: id, society: ctx.societyId, status: { $in: ['success', 'bounced'] } };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  const payment = await Payment.findOne(filter).populate(POPULATE).lean();
  if (!payment) throw ApiError.notFound('Receipt not found');
  return payment;
}

async function receiptData(societyId, payment) {
  const [society, bill, credit] = await Promise.all([
    Society.findById(societyId).select('name address city state pincode').lean(),
    payment.bill ? Bill.findById(payment.bill._id).select('billNumber period total paid lines').lean() : null,
    creditBalance(societyId, payment.unit._id),
  ]);
  return { society, payment, bill: bill ? { ...bill, balance: Math.max(0, bill.total - bill.paid) } : null, creditBalance: credit };
}

export async function receipt(ctx, id) {
  return receiptData(ctx.societyId, await findReceipt(ctx, id));
}

const receiptFile = async (data) => ({ filename: `${data.payment.receiptNumber || 'receipt'}.pdf`, buffer: await receiptPdf({ ...data, unit: data.payment.unit }) });

export async function receiptPdfBuffer(ctx, id) {
  return receiptFile(await receipt(ctx, id));
}

// "Email me this receipt".
export async function emailReceipt(ctx, id) {
  if (!ctx.user?.email) throw ApiError.badRequest('Add an email address to your profile first');
  const data = await receipt(ctx, id);
  const file = await receiptFile(data);
  sendEmailQuietly({ to: ctx.user.email, society: ctx.societyId, subject: `Receipt ${data.payment.receiptNumber}`, text: receiptText(ctx.user.name, data), attachments: [{ filename: file.filename, content: file.buffer, type: 'application/pdf' }] });
  return { sent: true, to: ctx.user.email };
}

const receiptText = (name, { payment, bill, creditBalance: credit }) =>
  `Hi ${name},\n\nWe received ${money(payment.amount)} (${payment.method}) ${bill ? `for bill ${bill.billNumber}` : 'as advance'}. Receipt ${payment.receiptNumber} is attached.\n${credit ? `Advance balance: ${money(credit)}\n` : ''}`;

// Sent automatically after every successful payment to the household's residents who allow email.
export async function emailReceiptToHousehold(societyId, paymentId) {
  const payment = await Payment.findOne({ _id: paymentId, society: societyId }).populate(POPULATE).lean();
  if (!payment) return;
  const members = await Membership.find({ society: societyId, unit: payment.unit._id, role: ROLES.RESIDENT, status: 'active' }).populate('user', 'name email notificationPrefs').lean();
  const recipients = members.map((m) => m.user).filter((u) => u?.email && u.notificationPrefs?.email !== false);
  if (!recipients.length) return;
  const data = await receiptData(societyId, payment);
  const file = await receiptFile(data);
  for (const u of recipients) {
    sendEmailQuietly({ to: u.email, society: societyId, subject: `Payment receipt ${payment.receiptNumber}`, text: receiptText(u.name, data), attachments: [{ filename: file.filename, content: file.buffer, type: 'application/pdf' }] });
  }
}

// Marks a cheque as bounced: the payment stops counting, the bill's paid amount goes back, any advance
// it created is withdrawn, and the society's bounce charge (if any) is queued for the next bill.
export async function bounce(ctx, id, { reason, charge = true }) {
  const payment = await Payment.findOne({ _id: id, society: ctx.societyId });
  if (!payment) throw ApiError.notFound('Payment not found');
  if (payment.status !== 'success') throw ApiError.conflict('Payment is {status}', { params: { status: payment.status } });
  if (payment.method !== 'cheque') throw ApiError.badRequest('Only cheque payments can bounce');
  const settings = await financeSettings.forSociety(ctx.societyId);
  const applied = payment.appliedAmount ?? (payment.bill ? payment.amount : 0);
  const fee = charge !== false ? settings.chequeBounceCharge : 0;

  const result = await withTransaction(async (session) => {
    // Withdraw the advance first: it is the step that can legitimately fail (credit already used).
    if (payment.advanceAmount > 0) await reverseAdvance(ctx, payment._id, `Payment ${payment.receiptNumber} bounced`, session);
    const claimed = await Payment.findOneAndUpdate(
      { _id: id, society: ctx.societyId, status: 'success' },
      { status: 'bounced', bouncedAt: new Date(), bounceReason: reason, bouncedBy: ctx.userId },
      { returnDocument: 'after', session },
    );
    if (!claimed) throw ApiError.conflict('Payment was already updated');
    let bill = null;
    if (applied > 0 && payment.bill) {
      bill = await reversePaid(ctx.societyId, payment.bill, applied, { session });
      if (!bill) throw ApiError.conflict('Could not reverse the payment on its bill');
    }
    const adj = fee > 0 ? await recordBounceCharge(ctx, { unit: payment.unit, payment: payment._id, amount: fee, reason: `Cheque ${payment.reference || ''} bounced: ${reason}`.trim() }, session) : null;
    return { bill, adj };
  });

  audit.record(ctx, 'payment.bounced', 'Payment', payment._id, { receipt: payment.receiptNumber, amount: payment.amount, reason, charge: fee });
  const unpaid = result.bill ? ` ${result.bill.billNumber} is due again (${money(result.bill.total - result.bill.paid)}).` : '';
  await notifyUnit(ctx.societyId, payment.unit, {
    type: 'bill',
    title: `Cheque ${payment.reference || ''} bounced`.replace(/\s+/g, ' '),
    body: `${money(payment.amount)} (${payment.receiptNumber}) was returned: ${reason}.${unpaid}${fee ? ` A bounce charge of ${money(fee)} will be added to your next bill.` : ''}`,
    link: '/billing',
    channels: ['inapp', 'push', 'email'],
  });
  invalidate(ctx.societyId, ['bills', 'payments', 'finance'], { unit: payment.unit });
  return { payment: await Payment.findById(id).populate(POPULATE).lean(), bill: result.bill, bounceCharge: result.adj?.amount || 0 };
}
