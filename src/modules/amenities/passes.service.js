import Amenity from './amenity.model.js';
import AmenityPass, { AmenityPassPlan } from './amenityPass.model.js';
import AmenityPayment from './amenityPayment.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { randomCode } from '../../common/utils/codes.js';
import { localDateString } from '../../common/utils/dates.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { ROLES } from '../../common/constants/index.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';
import * as pay from './amenityPayment.service.js';

const isManager = (ctx) => [ROLES.ADMIN, ROLES.FACILITY_MANAGER].includes(ctx.role);
const ONLINE_HOLD_MINUTES = 30;
const POPULATE = [
  { path: 'amenity', select: 'name' },
  { path: 'plan', select: 'name durationDays price' },
  { path: 'unit', select: 'label' },
  { path: 'holder', select: 'name phone' },
];
const addDaysISO = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// ---------- plans ----------
export async function listPlans(ctx, amenityId) {
  const filter = { society: ctx.societyId };
  if (amenityId) filter.amenity = amenityId;
  if (!isManager(ctx)) filter.active = true;
  return AmenityPassPlan.find(filter).populate('amenity', 'name').sort({ price: 1 }).lean();
}

export async function createPlan(ctx, amenityId, data) {
  const amenity = await Amenity.findOne({ _id: amenityId, society: ctx.societyId }).select('_id').lean();
  if (!amenity) throw ApiError.notFound('Amenity not found');
  try {
    const plan = await AmenityPassPlan.create({ ...data, amenity: amenity._id, society: ctx.societyId });
    audit.record(ctx, 'amenity_pass_plan.created', 'AmenityPassPlan', plan._id, data);
    return plan.toObject();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('A plan with this name already exists for the amenity');
    throw err;
  }
}

export async function updatePlan(ctx, planId, data) {
  const plan = await AmenityPassPlan.findOneAndUpdate({ _id: planId, society: ctx.societyId }, { $set: data }, { returnDocument: 'after', runValidators: true }).lean();
  if (!plan) throw ApiError.notFound('Plan not found');
  audit.record(ctx, 'amenity_pass_plan.updated', 'AmenityPassPlan', plan._id, data);
  return plan;
}

// ---------- passes ----------
async function uniqueCode(societyId) {
  for (let i = 0; i < 10; i += 1) {
    const code = randomCode(8);
    // eslint-disable-next-line no-await-in-loop
    if (!(await AmenityPass.exists({ society: societyId, code }))) return code;
  }
  throw new Error('Could not generate a pass code');
}

const reload = (id) => AmenityPass.findById(id).populate(POPULATE).lean();

// A resident buys a pass for themselves or another app member of the same home.
export async function buy(ctx, { plan: planId, holder, validFrom }) {
  const plan = await AmenityPassPlan.findOne({ _id: planId, society: ctx.societyId, active: true }).lean();
  if (!plan) throw ApiError.notFound('Pass plan not found');
  const amenity = await Amenity.findById(plan.amenity).select('name active paymentMode').lean();
  if (!amenity?.active) throw ApiError.badRequest('This amenity is not available');
  await pay.assertNotBlocked(ctx);

  let holderId = ctx.userId;
  if (holder && String(holder) !== String(ctx.userId)) {
    const sameHome = ctx.unitId && (await Membership.exists({ society: ctx.societyId, unit: ctx.unitId, user: holder, role: ROLES.RESIDENT, status: 'active' }));
    if (!sameHome) throw ApiError.badRequest('Passes can be bought only for members of your home');
    holderId = holder;
  }
  const start = validFrom || localDateString();
  if (start < localDateString()) throw ApiError.badRequest('The pass cannot start in the past');
  const end = addDaysISO(start, plan.durationDays - 1);
  const clash = await AmenityPass.exists({
    society: ctx.societyId,
    holder: holderId,
    amenity: plan.amenity,
    status: { $in: ['active', 'payment_pending'] },
    validFrom: { $lte: end },
    validTo: { $gte: start },
  });
  if (clash) throw ApiError.conflict('This member already has a pass for these dates');

  const free = !plan.price;
  const desk = !free && amenity.paymentMode === 'desk';
  const pass = await AmenityPass.create({
    society: ctx.societyId,
    amenity: plan.amenity,
    plan: plan._id,
    unit: ctx.unitId || undefined,
    holder: holderId,
    purchasedBy: ctx.userId,
    code: await uniqueCode(ctx.societyId),
    validFrom: start,
    validTo: end,
    price: plan.price,
    status: free ? 'active' : 'payment_pending',
    paymentStatus: free ? 'not_required' : desk ? 'pay_at_desk' : 'pending',
    paymentDueAt: free || desk ? undefined : new Date(Date.now() + ONLINE_HOLD_MINUTES * 60000),
  });
  return reload(pass._id);
}

function scope(ctx) {
  const filter = { society: ctx.societyId };
  if (!isManager(ctx) && ctx.role !== ROLES.GUARD) {
    filter.$or = ctx.unitId ? [{ unit: ctx.unitId }, { holder: ctx.userId }] : [{ holder: ctx.userId }];
  }
  return filter;
}

async function load(ctx, id) {
  const pass = await AmenityPass.findOne({ ...scope(ctx), _id: id });
  if (!pass) throw ApiError.notFound('Pass not found');
  return pass;
}

export function list(ctx, filters, pagination) {
  const filter = scope(ctx);
  if (filters.amenity) filter.amenity = filters.amenity;
  if (filters.status) filter.status = filters.status;
  if (filters.code) filter.code = { $regex: `^${escapeRegex(filters.code.toUpperCase())}` };
  return paginate(AmenityPass, filter, pagination, { populate: POPULATE });
}

export const getById = async (ctx, id) => reload((await load(ctx, id))._id);

export async function payPass(ctx, id) {
  const pass = await load(ctx, id);
  if (pass.status !== 'payment_pending' || pass.paymentStatus !== 'pending') throw ApiError.conflict('This pass does not need online payment');
  if (pass.paymentDueAt && pass.paymentDueAt <= new Date()) throw ApiError.conflict('The payment window has lapsed. Buy the pass again.');
  const amenity = await Amenity.findById(pass.amenity).select('name').lean();
  const order = await pay.openOrder(ctx, {
    pass: pass._id,
    amenity: pass.amenity,
    unit: pass.unit,
    receipt: `PASS-${pass.code}`,
    charges: [{ kind: 'fee', amount: pass.price, label: `${amenity.name} pass` }],
  });
  return { ...order, pass: pass._id };
}

export async function activatePaidPass(ctx, passId) {
  const pass = await AmenityPass.findOne({ _id: passId, society: ctx.societyId });
  if (!pass) throw ApiError.notFound('Pass not found');
  if (pass.status === 'active') return reload(pass._id);
  if (pass.status !== 'payment_pending') {
    await pay.refund(ctx, { pass: pass._id }, 'fee', pass.price);
    pass.paymentStatus = 'refunded';
    await pass.save();
    throw ApiError.conflict('This pass is no longer reserved, so your payment has been refunded');
  }
  pass.status = 'active';
  pass.paymentStatus = 'paid';
  pass.paymentDueAt = undefined;
  await pass.save();
  return reload(pass._id);
}

export async function markPassPaid(ctx, id, { method, reference }) {
  const pass = await load(ctx, id);
  if (pass.status !== 'payment_pending') throw ApiError.conflict(`Pass is ${pass.status}`);
  await AmenityPayment.updateMany({ society: ctx.societyId, pass: pass._id, status: 'created' }, { status: 'failed', notes: 'Paid at the desk instead' });
  await pay.recordOffline(ctx, { pass: pass._id, amenity: pass.amenity, unit: pass.unit, user: pass.purchasedBy, method, reference, charges: [{ kind: 'fee', amount: pass.price }] });
  pass.status = 'active';
  pass.paymentStatus = 'paid';
  pass.paymentDueAt = undefined;
  await pass.save();
  audit.record(ctx, 'amenity_pass.paid_at_desk', 'AmenityPass', pass._id, { amount: pass.price, method });
  return reload(pass._id);
}

// Residents can drop an unpaid pass; managers can cancel any pass and optionally refund part of it.
export async function cancelPass(ctx, id, { reason, refundAmount }) {
  const pass = await load(ctx, id);
  if (!['payment_pending', 'active'].includes(pass.status)) throw ApiError.conflict(`Pass is already ${pass.status}`);
  if (!isManager(ctx) && pass.status !== 'payment_pending') throw ApiError.forbidden('Ask the office to cancel an active pass');
  let refunded = 0;
  if (refundAmount) {
    const paid = await pay.paidTotal(ctx.societyId, { pass: pass._id }, 'fee');
    if (refundAmount > paid) throw ApiError.badRequest('Refund exceeds the amount paid');
    refunded = await pay.refund(ctx, { pass: pass._id }, 'fee', refundAmount);
    pass.paymentStatus = 'refunded';
  }
  await AmenityPayment.updateMany({ society: ctx.societyId, pass: pass._id, status: 'created' }, { status: 'failed', notes: 'Pass cancelled' });
  pass.status = 'cancelled';
  pass.cancelledAt = new Date();
  pass.cancelReason = reason;
  await pass.save();
  audit.record(ctx, 'amenity_pass.cancelled', 'AmenityPass', pass._id, { reason, refunded });
  if (isManager(ctx)) {
    await notifyUsers(ctx.societyId, [pass.holder, pass.purchasedBy], { type: 'booking', title: 'Amenity pass cancelled', body: reason || '', link: '/amenities?tab=passes' });
  }
  return { ...(await reload(pass._id)), refunded };
}

// Door check by the guard or facility manager (scanned QR or typed code). A valid check is logged as an entry.
export async function check(ctx, { code, amenity }) {
  const pass = await AmenityPass.findOne({ society: ctx.societyId, code: code.toUpperCase() }).populate(POPULATE);
  if (!pass) return { valid: false, reason: 'No pass with this code' };
  const today = localDateString();
  let reason = null;
  if (amenity && String(pass.amenity._id) !== String(amenity)) reason = `This pass is for ${pass.amenity.name}`;
  else if (pass.status === 'payment_pending') reason = 'Payment pending';
  else if (pass.status === 'cancelled') reason = 'Pass cancelled';
  else if (pass.status === 'expired' || pass.validTo < today) reason = `Expired on ${pass.validTo}`;
  else if (pass.validFrom > today) reason = `Valid from ${pass.validFrom}`;
  const summary = {
    _id: pass._id,
    code: pass.code,
    amenity: pass.amenity,
    holder: pass.holder,
    unit: pass.unit,
    plan: pass.plan,
    validFrom: pass.validFrom,
    validTo: pass.validTo,
    status: pass.status,
  };
  if (reason) return { valid: false, reason, pass: summary };
  pass.entries += 1;
  pass.lastEntryAt = new Date();
  await pass.save();
  return { valid: true, pass: { ...summary, entries: pass.entries } };
}

// ---------- scheduled ----------
export async function expirePasses(now = new Date()) {
  const today = localDateString(now);
  const expired = await AmenityPass.updateMany({ status: 'active', validTo: { $lt: today } }, { status: 'expired' });
  const lapsed = await AmenityPass.find({ status: 'payment_pending', paymentStatus: 'pending', paymentDueAt: { $lte: now } }).select('_id').lean();
  if (lapsed.length) {
    const ids = lapsed.map((p) => p._id);
    await AmenityPass.updateMany({ _id: { $in: ids } }, { status: 'cancelled', cancelledAt: now, cancelReason: 'Payment not completed in time' });
    await AmenityPayment.updateMany({ pass: { $in: ids }, status: 'created' }, { status: 'failed', notes: 'Payment window lapsed' });
  }
  return { expired: expired.modifiedCount, lapsed: lapsed.length };
}
