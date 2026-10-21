import crypto from 'node:crypto';
import PlanPrice from './planPrice.model.js';
import Subscription from './subscription.model.js';
import PlatformInvoice from './platformInvoice.model.js';
import SubscriptionPayment from './subscriptionPayment.model.js';
import { nextPlatformNumber } from './platformCounter.model.js';
import { invoicePdf } from './invoicePdf.js';
import { appLink, emailPlatformTeam, societyAdminEmails } from './platformMail.js';
import { BILLING_CYCLES, CYCLE_LABELS, CYCLE_MONTHS, DEFAULT_PRICES, GST_RATE, LIFETIME_UNTIL, PLAN_NAMES, REMIND_BEFORE_DAYS, REMIND_EVERY_DAYS, isLifetime } from './subscriptions.constants.js';
import Society from '../society/society.model.js';
import Unit from '../units/unit.model.js';
import * as platform from '../platform/platform.service.js';
import { mockProvider, provider } from '../payments/providers.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';
import { sendEmailQuietly } from '../../integrations/email.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { addDays, localDateString, startOfLocalDay } from '../../common/utils/dates.js';
import { money } from '../../common/utils/money.js';
import { ROLES } from '../../common/constants/index.js';
import logger from '../../common/utils/logger.js';

const DAY = 86400000;
const POPULATE_SOCIETY = { path: 'society', select: 'name code city active plan' };

// Calendar months in IST: 2026-01-31 + 1 month = 2026-02-28.
export function addLocalMonths(date, months) {
  const [y, m, d] = localDateString(date).split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const day = String(Math.min(d, last)).padStart(2, '0');
  return new Date(`${ny}-${String(nm).padStart(2, '0')}-${day}T00:00:00+05:30`);
}

const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
const strip = (inv) => {
  if (!inv) return inv;
  const { payToken, ...rest } = inv;
  return rest;
};

// ---------- price list ----------
const PRICE_FIELDS = ['perUnitMonthly', 'flatMonthly', 'quarterlyDiscountPercent', 'yearlyDiscountPercent', 'oneTimePrice', 'oneTimeValidityMonths', 'description', 'updatedAt'];

// Which cycles a plan can be billed on: recurring ones whenever the plan costs something, one-time only
// when the platform has set a one-time price.
export const cyclesFor = (price) => BILLING_CYCLES.filter((c) => (c === 'one_time' ? price.oneTimePrice > 0 : price.perUnitMonthly > 0 || price.flatMonthly > 0));

export async function listPrices() {
  const saved = await PlanPrice.find().lean();
  return PLAN_NAMES.map((plan) => {
    const doc = saved.find((p) => p.plan === plan);
    // Price documents saved before quarterly / one-time existed lack those fields: the defaults fill them.
    const own = doc ? Object.fromEntries(PRICE_FIELDS.filter((k) => doc[k] !== undefined).map((k) => [k, doc[k]])) : {};
    const price = { plan, ...DEFAULT_PRICES[plan], ...own, custom: Boolean(doc) };
    return { ...price, cycles: cyclesFor(price) };
  });
}

export async function priceFor(plan) {
  return (await listPrices()).find((p) => p.plan === plan) || { plan, ...DEFAULT_PRICES.free };
}

export async function updatePrice(platformUser, plan, data) {
  // The first save of a plan keeps the default price for every field it does not set.
  const defaults = Object.fromEntries(Object.entries(DEFAULT_PRICES[plan] || {}).filter(([k]) => data[k] === undefined));
  await PlanPrice.findOneAndUpdate({ plan }, { $set: { ...data, updatedBy: platformUser._id }, $setOnInsert: defaults }, { upsert: true, runValidators: true });
  logger.info({ plan, data, by: String(platformUser._id) }, 'platform price list updated');
  return priceFor(plan);
}

const DISCOUNT_FIELD = { quarterly: 'quarterlyDiscountPercent', yearly: 'yearlyDiscountPercent' };
const withTax = (subtotal) => {
  const gst = Math.round((subtotal * GST_RATE) / 100);
  return { subtotal, gstRate: GST_RATE, gst, total: subtotal + gst };
};

// Charge for one billing period. Quarterly and yearly carry their own discount; GST on the discounted subtotal.
// one_time: the plan's fixed one-time price for oneTimeValidityMonths (months 0 + lifetime when unset).
export function computeCharge({ units, price, cycle }) {
  if (cycle === 'one_time') {
    const validity = price.oneTimeValidityMonths || null;
    const amount = price.oneTimePrice || 0;
    const lines = amount > 0 ? [{ description: `One-time licence, ${validity ? `${validity} month${validity > 1 ? 's' : ''}` : 'lifetime'}`, amount }] : [];
    return { months: validity || 0, lifetime: !validity, lines, ...withTax(amount), discountPercent: 0 };
  }
  const months = CYCLE_MONTHS[cycle] || 1;
  const lines = [];
  if (price.perUnitMonthly > 0) {
    lines.push({ description: `${units} units × ${money(price.perUnitMonthly)} per unit per month × ${months} month${months > 1 ? 's' : ''}`, amount: units * price.perUnitMonthly * months });
  }
  if (price.flatMonthly > 0) lines.push({ description: `Platform fee ${money(price.flatMonthly)} per month × ${months}`, amount: price.flatMonthly * months });
  const gross = lines.reduce((s, l) => s + l.amount, 0);
  const discountPercent = DISCOUNT_FIELD[cycle] ? price[DISCOUNT_FIELD[cycle]] || 0 : 0;
  const discount = Math.round((gross * discountPercent) / 100);
  if (discount > 0) lines.push({ description: `${CYCLE_LABELS[cycle]} billing discount ${discountPercent}%`, amount: -discount });
  return { months, lifetime: false, lines, ...withTax(gross - discount), discountPercent };
}

// End of a period that starts at `start` (exclusive). Lifetime licences end at LIFETIME_UNTIL.
export const periodEndFor = (start, charge) => (charge.lifetime ? LIFETIME_UNTIL : addLocalMonths(start, charge.months));

async function assertCycleOffered(societyId, cycle) {
  if (!cycle) return;
  const society = await Society.findById(societyId).select('plan').lean();
  const price = await priceFor(society?.plan?.name || 'free');
  // Free and trial societies may pick any cycle for later; a paid plan without a one-time price can't use it.
  if (cycle === 'one_time' && !price.oneTimePrice && (price.perUnitMonthly || price.flatMonthly)) {
    throw ApiError.badRequest(`The ${society.plan.name} plan has no one-time price. Choose monthly, quarterly or yearly.`);
  }
}

// The cycle actually billed: if the platform withdrew a plan's one-time price after a society chose it,
// the society is billed monthly instead of getting a free "lifetime" period.
export const billedCycle = (cycle, price) => (cycle === 'one_time' && !price.oneTimePrice ? 'monthly' : cycle || 'monthly');

// ---------- subscription ----------
export async function ensureSubscription(societyId) {
  return Subscription.findOneAndUpdate({ society: societyId }, { $setOnInsert: { society: societyId } }, { upsert: true, returnDocument: 'after' }).lean();
}

async function overview(societyId) {
  const [society, sub] = await Promise.all([Society.findById(societyId).select('name code active plan suspendedReason').lean(), ensureSubscription(societyId)]);
  if (!society) throw ApiError.notFound('Society not found');
  const [price, units, unpaid] = await Promise.all([
    priceFor(society.plan?.name || 'free'),
    Unit.countDocuments({ society: societyId }),
    PlatformInvoice.find({ society: societyId, status: 'unpaid' }).sort({ dueDate: 1 }).lean(),
  ]);
  const cycle = billedCycle(sub.billingCycle, price);
  const estimate = computeCharge({ units, price, cycle });
  const now = new Date();
  return {
    society,
    subscription: sub,
    price,
    units,
    nextInvoice: { ...estimate, cycle, startsOn: sub.billedUntil || startOfLocalDay(now) },
    // What each cycle would cost now, for the cycle picker.
    cycleOptions: BILLING_CYCLES.map((c) => ({ cycle: c, label: CYCLE_LABELS[c], available: c !== 'one_time' || price.oneTimePrice > 0, ...computeCharge({ units, price, cycle: c }) })),
    outstanding: unpaid.reduce((s, i) => s + i.total, 0),
    overdueInvoices: unpaid.filter((i) => i.dueDate < now).length,
    suspendsOn: unpaid.length ? addDays(unpaid[0].dueDate, sub.graceDays) : null,
  };
}

export const getMine = (ctx) => overview(ctx.societyId);
export const getForSociety = (societyId) => overview(societyId);

export async function updateMine(ctx, data) {
  await assertCycleOffered(ctx.societyId, data.billingCycle);
  await ensureSubscription(ctx.societyId);
  await Subscription.updateOne({ society: ctx.societyId }, { $set: data }, { runValidators: true });
  audit.record(ctx, 'subscription.updated', 'Subscription', null, data);
  return overview(ctx.societyId);
}

export async function updateForSociety(platformUser, societyId, data) {
  if (!(await Society.exists({ _id: societyId }))) throw ApiError.notFound('Society not found');
  await assertCycleOffered(societyId, data.billingCycle);
  await ensureSubscription(societyId);
  await Subscription.updateOne({ society: societyId }, { $set: data }, { runValidators: true });
  audit.record({ societyId, userId: platformUser._id }, 'platform.subscription_updated', 'Subscription', null, data);
  return overview(societyId);
}

// ---------- notifications ----------
async function tellSocietyAdmins(invoice, { title, body, attachPdf = false }) {
  await notifyRoles(invoice.society, [ROLES.ADMIN], { type: 'subscription', title, body, link: '/subscription', channels: ['inapp'] });
  const sub = await Subscription.findOne({ society: invoice.society }).lean();
  const to = await societyAdminEmails(invoice.society, [sub?.billingEmail]);
  if (!to.length) return;
  const token = invoice.payToken || (await PlatformInvoice.findById(invoice._id).select('+payToken').lean())?.payToken;
  const attachments = [];
  if (attachPdf) {
    const society = await Society.findById(invoice.society).lean();
    const fresh = await PlatformInvoice.findById(invoice._id).lean();
    attachments.push({ filename: `${invoice.number}.pdf`, content: await invoicePdf({ invoice: fresh, society, subscription: sub }), type: 'application/pdf' });
  }
  sendEmailQuietly({
    to,
    subject: title,
    text: `${body}\n\nInvoice ${invoice.number}: ${money(invoice.total)} due on ${localDateString(invoice.dueDate)}.\nPay online (works even if your account is suspended): ${appLink(`/subscription/pay/${token}`)}\n\nColonyHub`,
    attachments,
  });
}

// ---------- invoice generation (scheduled) ----------
async function createInvoice(society, sub, periodStart) {
  const [units, price] = await Promise.all([Unit.countDocuments({ society: society._id }), priceFor(society.plan?.name || 'free')]);
  const cycle = billedCycle(sub.billingCycle, price);
  const charge = computeCharge({ units, price, cycle });
  const periodEnd = periodEndFor(periodStart, charge);
  if (charge.subtotal <= 0) return { periodEnd: addLocalMonths(periodStart, CYCLE_MONTHS.monthly), invoice: null };
  try {
    const invoice = await PlatformInvoice.create({
      society: society._id,
      number: await nextPlatformNumber('platform_invoice', 'PINV'),
      plan: society.plan?.name || 'free',
      billingCycle: cycle,
      periodStart,
      periodEnd,
      units,
      perUnitMonthly: price.perUnitMonthly,
      flatMonthly: price.flatMonthly,
      ...charge,
      dueDate: addDays(periodStart, sub.dueDays),
      payToken: crypto.randomBytes(24).toString('base64url'),
    });
    return { periodEnd, invoice: invoice.toObject() };
  } catch (err) {
    if (err.code === 11000) return { periodEnd, invoice: null, duplicate: true }; // another instance got there first
    throw err;
  }
}

// Bills every active paying society for each period that has started. Catches up at most 3 periods per run.
export async function generateDueInvoices(now = new Date()) {
  const societies = await Society.find({ active: true }).select('_id name plan').lean();
  let created = 0;
  const prices = await listPrices();
  for (const society of societies) {
    const planName = society.plan?.name || 'free';
    // trial (and any unpriced plan) bills nothing, like free
    const price = prices.find((p) => p.plan === planName) || { plan: planName, ...DEFAULT_PRICES.free };
    // eslint-disable-next-line no-await-in-loop
    const sub = await ensureSubscription(society._id);
    const billable = price.perUnitMonthly || price.flatMonthly || (sub.billingCycle === 'one_time' && price.oneTimePrice);
    if (!billable) {
      // Nothing to bill on a free plan; billing restarts from the day the society upgrades again.
      // eslint-disable-next-line no-await-in-loop
      if (sub.billedUntil && sub.billedUntil <= now) await Subscription.updateOne({ _id: sub._id }, { $unset: { billedUntil: 1 } });
      continue;
    }
    const today = startOfLocalDay(now);
    // A paid-until set by hand in the console (before subscriptions existed) is honoured.
    let start = sub.billedUntil || later(today, society.plan?.validUntil && society.plan.validUntil > today ? startOfLocalDay(society.plan.validUntil) : null);
    let billedUntil = sub.billedUntil;
    for (let i = 0; i < 3 && start <= now; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { periodEnd, invoice, duplicate } = await createInvoice(society, sub, start);
      if (duplicate) break; // another instance is billing this society right now
      billedUntil = periodEnd;
      start = periodEnd;
      if (invoice) {
        created += 1;
        // eslint-disable-next-line no-await-in-loop
        await tellSocietyAdmins(invoice, { title: `New ColonyHub invoice ${invoice.number}`, body: `Your ${(CYCLE_LABELS[invoice.billingCycle] || invoice.billingCycle).toLowerCase()} subscription invoice for ${money(invoice.total)} (incl. GST) is ready.`, attachPdf: true });
      }
    }
    // eslint-disable-next-line no-await-in-loop
    if (String(billedUntil) !== String(sub.billedUntil)) await Subscription.updateOne({ _id: sub._id }, { billedUntil });
  }
  return { societies: societies.length, created };
}

// ---------- dunning (scheduled) ----------
async function remind(invoice, stage, now, message) {
  await tellSocietyAdmins(invoice, message);
  await PlatformInvoice.updateOne({ _id: invoice._id }, { $push: { reminders: { stage, at: now } }, lastReminderAt: now });
}

// Reminders before / after the due date, then suspension once the grace period is over.
export async function runDunning(now = new Date()) {
  const invoices = await PlatformInvoice.find({ status: 'unpaid', dueDate: { $lte: addDays(now, REMIND_BEFORE_DAYS) } })
    .select('+payToken')
    .sort({ dueDate: 1 })
    .limit(2000)
    .lean();
  const result = { reminded: 0, suspended: 0 };
  for (const inv of invoices) {
    // eslint-disable-next-line no-await-in-loop
    const sub = await ensureSubscription(inv.society);
    const stages = new Set(inv.reminders.map((r) => r.stage));
    const suspendAt = addDays(inv.dueDate, sub.graceDays);
    if (now < inv.dueDate) {
      if (stages.has('before')) continue;
      // eslint-disable-next-line no-await-in-loop
      await remind(inv, 'before', now, { title: `Invoice ${inv.number} is due soon`, body: `${money(inv.total)} is due on ${localDateString(inv.dueDate)}.` });
      result.reminded += 1;
    } else if (now >= suspendAt) {
      if (stages.has('suspended')) continue; // suspend once per invoice; a manual reactivation by the platform sticks
      // eslint-disable-next-line no-await-in-loop
      const society = await Society.findById(inv.society).select('active').lean();
      const reason = `Subscription invoice ${inv.number} is unpaid. Pay it online to restore access.`;
      if (society?.active) {
        // eslint-disable-next-line no-await-in-loop
        await platform.systemUpdateSociety(inv.society, { active: false, suspendedReason: reason }, 'subscription.auto_suspended');
        // eslint-disable-next-line no-await-in-loop
        await Subscription.updateOne({ _id: sub._id }, { status: 'suspended', autoSuspendReason: reason, suspendedAt: now });
        result.suspended += 1;
        // eslint-disable-next-line no-await-in-loop
        await emailPlatformTeam({ permission: 'invoices.manage', subject: `Society suspended for non-payment (${inv.number})`, text: `The society was suspended automatically: ${reason}` });
      }
      // eslint-disable-next-line no-await-in-loop
      await remind(inv, 'suspended', now, { title: 'Your ColonyHub account is suspended', body: `${reason} Members cannot use the app until it is paid.` });
    } else {
      const due = !stages.has('overdue') || !inv.lastReminderAt || inv.lastReminderAt <= addDays(now, -REMIND_EVERY_DAYS);
      if (sub.status === 'active') {
        // eslint-disable-next-line no-await-in-loop
        await Subscription.updateOne({ _id: sub._id }, { status: 'past_due' });
      }
      if (!due) continue;
      const daysLeft = Math.max(0, Math.ceil((suspendAt - now) / DAY));
      // eslint-disable-next-line no-await-in-loop
      await remind(inv, 'overdue', now, { title: `Invoice ${inv.number} is overdue`, body: `${money(inv.total)} was due on ${localDateString(inv.dueDate)}. Access will be suspended in ${daysLeft} day${daysLeft === 1 ? '' : 's'} unless it is paid.` });
      result.reminded += 1;
    }
  }
  return result;
}

// ---------- invoices ----------
function invoiceFilter(filters) {
  const filter = {};
  if (filters.status) filter.status = filters.status;
  if (filters.overdue) {
    filter.status = 'unpaid';
    filter.dueDate = { $lt: new Date() };
  }
  return filter;
}

export const listMine = (ctx, filters, pagination) => paginate(PlatformInvoice, { ...invoiceFilter(filters), society: ctx.societyId }, pagination);

export function listAll(filters, pagination) {
  const filter = invoiceFilter(filters);
  if (filters.society) filter.society = filters.society;
  return paginate(PlatformInvoice, filter, pagination, { populate: POPULATE_SOCIETY });
}

export async function platformSummary() {
  const now = new Date();
  const [byStatus, overdue] = await Promise.all([
    PlatformInvoice.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total' } } }]),
    PlatformInvoice.aggregate([{ $match: { status: 'unpaid', dueDate: { $lt: now } } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } }]),
  ]);
  const s = Object.fromEntries(byStatus.map((b) => [b._id, { count: b.count, total: b.total }]));
  return { paid: s.paid || { count: 0, total: 0 }, unpaid: s.unpaid || { count: 0, total: 0 }, overdue: overdue[0] ? { count: overdue[0].count, total: overdue[0].total } : { count: 0, total: 0 } };
}

async function loadInvoice(filter) {
  const invoice = await PlatformInvoice.findOne(filter).select('+payToken').lean();
  if (!invoice) throw ApiError.notFound('Invoice not found');
  return invoice;
}

export async function getMineById(ctx, id) {
  const invoice = await loadInvoice({ _id: id, society: ctx.societyId });
  const payments = await SubscriptionPayment.find({ invoice: id, status: 'success' }).lean();
  // Admins can forward the pay link (e.g. to the treasurer).
  return { ...strip(invoice), payLink: invoice.status === 'unpaid' ? appLink(`/subscription/pay/${invoice.payToken}`) : null, payments };
}

export async function getAnyById(id) {
  const invoice = await PlatformInvoice.findById(id).populate(POPULATE_SOCIETY).lean();
  if (!invoice) throw ApiError.notFound('Invoice not found');
  const payments = await SubscriptionPayment.find({ invoice: id }).sort({ createdAt: -1 }).lean();
  return { ...invoice, payments };
}

async function renderPdf(invoice) {
  const [society, subscription] = await Promise.all([Society.findById(invoice.society).lean(), Subscription.findOne({ society: invoice.society }).lean()]);
  return { filename: `${invoice.number}.pdf`, buffer: await invoicePdf({ invoice, society, subscription }) };
}

export async function pdfMine(ctx, id) {
  return renderPdf(strip(await loadInvoice({ _id: id, society: ctx.societyId })));
}

export async function pdfAny(id) {
  return renderPdf(strip(await loadInvoice({ _id: id })));
}

// ---------- payment settlement ----------
// Called once money is confirmed. Marks the invoice paid, extends paid-until (here and on the Society),
// and lifts a suspension the dunning job imposed when nothing else is overdue past grace.
async function settle(payment, actorId) {
  const invoice = await PlatformInvoice.findOneAndUpdate(
    { _id: payment.invoice, status: 'unpaid' },
    { status: 'paid', paidAt: payment.paidAt, payment: payment._id },
    { returnDocument: 'after' },
  ).lean();
  if (!invoice) {
    payment.status = 'failed';
    payment.notes = 'Captured but not applied: invoice was already paid or voided. Refund required.';
    await payment.save();
    await emailPlatformTeam({ permission: 'invoices.manage', subject: 'Subscription payment needs a refund', text: `Payment ${payment.providerPaymentId || payment._id} (${money(payment.amount)}) could not be applied.` });
    throw ApiError.conflict('This invoice is no longer payable');
  }
  payment.status = 'success';
  await payment.save();

  const sub = await ensureSubscription(invoice.society);
  const paidUntil = later(sub.paidUntil, invoice.periodEnd);
  const now = new Date();
  const stillOverdue = await PlatformInvoice.exists({ society: invoice.society, status: 'unpaid', dueDate: { $lt: addDays(now, -sub.graceDays) } });
  const anyOverdue = await PlatformInvoice.exists({ society: invoice.society, status: 'unpaid', dueDate: { $lt: now } });
  const society = await Society.findById(invoice.society).select('active suspendedReason').lean();
  const lift = !society.active && sub.autoSuspendReason && society.suspendedReason === sub.autoSuspendReason && !stillOverdue;

  await platform.systemUpdateSociety(invoice.society, { validUntil: paidUntil, ...(lift ? { active: true } : {}) }, lift ? 'subscription.reactivated_after_payment' : 'subscription.paid');
  await Subscription.updateOne(
    { _id: sub._id },
    { $set: { paidUntil, status: lift || society.active ? (anyOverdue ? 'past_due' : 'active') : sub.status }, ...(lift ? { $unset: { autoSuspendReason: 1, suspendedAt: 1 } } : {}) },
  );
  audit.record({ societyId: invoice.society, userId: actorId },'subscription.payment', 'PlatformInvoice', invoice._id, { number: invoice.number, amount: payment.amount, method: payment.method });
  await notifyRoles(invoice.society, [ROLES.ADMIN], { type: 'subscription', title: `Payment received for ${invoice.number}`, body: `${money(payment.amount)} · paid until ${localDateString(paidUntil)}`, link: '/subscription', channels: ['inapp', 'email'] });
  await emailPlatformTeam({ permission: 'invoices.manage', subject: `Subscription paid: ${invoice.number}`, text: `${money(payment.amount)} received (${payment.method}).${lift ? ' The society was reactivated.' : ''}` });
  return { invoice: strip(invoice), payment: payment.toObject(), paidUntil, reactivated: Boolean(lift) };
}

async function openOrder(invoice, paidBy) {
  if (invoice.status !== 'unpaid') throw ApiError.conflict('Invoice is {status}', { params: { status: invoice.status } });
  const order = await provider.createOrder({ amount: invoice.total, receipt: invoice.number, notes: { platformInvoice: String(invoice._id) } });
  await SubscriptionPayment.create({
    society: invoice.society,
    invoice: invoice._id,
    amount: invoice.total,
    method: 'online',
    provider: provider.name,
    providerOrderId: order.orderId,
    paidBy,
  });
  return { ...order, provider: provider.name, invoiceNumber: invoice.number };
}

async function verifyOrder(invoiceFilter, { orderId, paymentId, signature }, actorId, { trusted = false } = {}) {
  const payment = await SubscriptionPayment.findOne({ providerOrderId: orderId });
  if (!payment || !(await PlatformInvoice.exists({ ...invoiceFilter, _id: payment.invoice }))) throw ApiError.notFound('Order not found');
  if (payment.status === 'success') {
    // idempotent: the client retried after a network error
    const sub = await Subscription.findOne({ society: payment.society }).lean();
    return { invoice: await PlatformInvoice.findById(payment.invoice).lean(), payment: payment.toObject(), paidUntil: sub?.paidUntil, reactivated: false };
  }
  if (!trusted && !(await provider.verify({ orderId, paymentId, signature }))) {
    payment.status = 'failed';
    await payment.save();
    throw ApiError.badRequest('Payment verification failed');
  }
  // Claim it so a checkout verify racing the webhook settles the invoice once.
  const claimed = await SubscriptionPayment.updateOne({ _id: payment._id, status: { $ne: 'success' }, providerPaymentId: { $exists: false } }, { providerPaymentId: paymentId });
  if (!claimed.modifiedCount) {
    const sub = await Subscription.findOne({ society: payment.society }).lean();
    return { invoice: await PlatformInvoice.findById(payment.invoice).lean(), payment: (await SubscriptionPayment.findById(payment._id).lean()), paidUntil: sub?.paidUntil, reactivated: false };
  }
  payment.providerPaymentId = paymentId;
  payment.paidAt = new Date();
  return settle(payment, actorId);
}

// Provider webhook: a subscription invoice order was captured. Returns false for unknown orders.
export async function captureByOrder({ orderId, paymentId }) {
  const payment = await SubscriptionPayment.findOne({ providerOrderId: orderId }).lean();
  if (!payment) return false;
  if (payment.status !== 'success') await verifyOrder({}, { orderId, paymentId }, payment.paidBy, { trusted: true });
  return true;
}

export async function createOrder(ctx, invoiceId) {
  return openOrder(await loadInvoice({ _id: invoiceId, society: ctx.societyId }), ctx.userId);
}

export const verify = (ctx, body) => verifyOrder({ society: ctx.societyId }, body, ctx.userId);

// Stand-in for the provider checkout in development (mock provider only).
export function mockSign(orderId) {
  if (provider.name !== 'mock') throw ApiError.notFound();
  const paymentId = `mock_pay_${crypto.randomBytes(8).toString('hex')}`;
  return { orderId, paymentId, signature: mockProvider.sign(orderId, paymentId) };
}

// ---------- pay link (no society session needed) ----------
const byToken = (token) => loadInvoice({ payToken: token });

export async function getByToken(token) {
  const invoice = await byToken(token);
  const society = await Society.findById(invoice.society).select('name city active suspendedReason').lean();
  return { invoice: strip(invoice), society, provider: provider.name };
}

export const createOrderByToken = async (token, userId) => openOrder(await byToken(token), userId);

export async function verifyByToken(token, body, userId) {
  const invoice = await byToken(token);
  return verifyOrder({ _id: invoice._id }, body, userId);
}

export async function mockSignByToken(token, orderId) {
  const invoice = await byToken(token);
  if (!(await SubscriptionPayment.exists({ invoice: invoice._id, providerOrderId: orderId }))) throw ApiError.notFound('Order not found');
  return mockSign(orderId);
}

// ---------- platform actions ----------
export async function markPaid(platformUser, id, data) {
  const invoice = await loadInvoice({ _id: id });
  if (invoice.status !== 'unpaid') throw ApiError.conflict('Invoice is {status}', { params: { status: invoice.status } });
  const payment = new SubscriptionPayment({
    society: invoice.society,
    invoice: invoice._id,
    amount: invoice.total,
    method: data.method,
    reference: data.reference,
    notes: data.notes,
    paidAt: data.paidAt || new Date(),
    recordedBy: platformUser._id,
  });
  return settle(payment, platformUser._id);
}

export async function voidInvoice(platformUser, id, reason) {
  const invoice = await PlatformInvoice.findOneAndUpdate({ _id: id, status: 'unpaid' }, { status: 'void', voidReason: reason }, { returnDocument: 'after' }).lean();
  if (!invoice) throw ApiError.conflict('Only unpaid invoices can be voided');
  audit.record({ societyId: invoice.society, userId: platformUser._id }, 'platform.invoice_voided', 'PlatformInvoice', invoice._id, { number: invoice.number, reason });
  return strip(invoice);
}

// ---------- prepaid terms (white-label licence keys) ----------
// A licence key prepays `plan` for one term of `cycle` (one_time: validityMonths, or lifetime when unset).
// The term starts today, or at the current paid-until if that is later, so applying a key never shortens
// what was already paid. Billing resumes from the end of the term (proration-free: no partial credit).
export async function applyPrepaidTerm(societyId, { plan, cycle, validityMonths, keyId }, now = new Date()) {
  const sub = await ensureSubscription(societyId);
  const today = startOfLocalDay(now);
  const from = later(today, sub.paidUntil && sub.paidUntil > today ? sub.paidUntil : null);
  let until;
  if (isLifetime(from) || (cycle === 'one_time' && !validityMonths)) until = LIFETIME_UNTIL;
  else until = addLocalMonths(from, cycle === 'one_time' ? validityMonths : CYCLE_MONTHS[cycle]);
  if (until > LIFETIME_UNTIL) until = LIFETIME_UNTIL;
  await platform.systemUpdateSociety(societyId, { plan: { name: plan, validUntil: until } }, 'licence.applied');
  await Subscription.updateOne(
    { _id: sub._id },
    { $set: { billingCycle: cycle, paidUntil: until, billedUntil: later(sub.billedUntil, until), licenceKey: keyId, licenceUntil: until, status: 'active' } },
  );
  return { paidUntil: until, lifetime: isLifetime(until) };
}

export const CYCLES = BILLING_CYCLES;
