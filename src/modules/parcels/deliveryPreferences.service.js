import DeliveryPreference from './deliveryPreference.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { localDateString } from '../../common/utils/dates.js';
import { invalidate } from '../../realtime/socket.js';

const companyKey = (c) => (c ? c.trim().toLowerCase() : null);

export function listForUnit(ctx, unitId) {
  return DeliveryPreference.find({ society: ctx.societyId, unit: unitId, active: true, $or: [{ oneOffDate: null }, { oneOffDate: { $gte: localDateString() }, usedAt: null }] })
    .sort({ createdAt: -1 })
    .lean();
}

export async function create(ctx, { company, oneOff, date, note }) {
  if (!ctx.unitId) throw ApiError.badRequest('Only residents linked to a unit can set delivery preferences');
  const key = companyKey(company);
  const oneOffDate = oneOff ? date || localDateString() : null;
  if (oneOffDate && oneOffDate < localDateString()) throw ApiError.badRequest('Pick today or a future date');
  // One standing rule per company is enough; replace instead of stacking duplicates.
  if (!oneOffDate) await DeliveryPreference.updateMany({ society: ctx.societyId, unit: ctx.unitId, companyKey: key, oneOffDate: null, active: true }, { active: false });
  const doc = await DeliveryPreference.create({
    society: ctx.societyId,
    unit: ctx.unitId,
    company: company?.trim() || null,
    companyKey: key,
    oneOffDate,
    note,
    createdBy: ctx.userId,
  });
  invalidate(ctx.societyId, ['parcels'], { roles: ['guard'], unit: ctx.unitId });
  return doc.toObject();
}

export async function remove(ctx, id) {
  const res = await DeliveryPreference.updateOne({ _id: id, society: ctx.societyId, unit: ctx.unitId, active: true }, { active: false });
  if (!res.modifiedCount) throw ApiError.notFound('Preference not found');
  invalidate(ctx.societyId, ['parcels'], { roles: ['guard'], unit: ctx.unitId });
}

// The rule that applies to a delivery from `company` for this unit right now, if any.
// A company-specific rule wins over an "any company" rule; one-offs win over standing rules.
export async function findLeaveAtGate(societyId, unitId, company, now = new Date()) {
  const key = companyKey(company);
  const today = localDateString(now);
  const prefs = await DeliveryPreference.find({
    society: societyId,
    unit: unitId,
    active: true,
    companyKey: key ? { $in: [key, null] } : null,
    $or: [{ oneOffDate: null }, { oneOffDate: today, usedAt: null }],
  }).lean();
  if (!prefs.length) return null;
  const score = (p) => (p.companyKey ? 2 : 0) + (p.oneOffDate ? 1 : 0);
  return prefs.sort((a, b) => score(b) - score(a))[0];
}

// Marks a one-off rule as used (standing rules are untouched).
export async function consume(pref, now = new Date()) {
  if (pref?.oneOffDate) await DeliveryPreference.updateOne({ _id: pref._id, usedAt: null }, { usedAt: now });
}
