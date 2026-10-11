import Household from './household.model.js';
import Unit from '../units/unit.model.js';
import Membership from '../users/membership.model.js';
import SosAlert from '../sos/sos.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { ROLES } from '../../common/constants/index.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';

const EMPTY = { members: [], pets: [], emergencyContacts: [], residentMedical: [], medicalNotes: undefined };
// Upload-id fields that must be turned into stored attachments.
const FILE_FIELDS = ['photo', 'vaccinationCertificate'];

function requireUnit(ctx) {
  if (!ctx.unitId) throw ApiError.badRequest('Your membership is not linked to a unit');
  return ctx.unitId;
}

export function ageOf(person, today = new Date()) {
  if (person.dob) {
    const dob = new Date(`${person.dob}T00:00:00Z`);
    let age = today.getUTCFullYear() - dob.getUTCFullYear();
    const m = today.getUTCMonth() - dob.getUTCMonth();
    if (m < 0 || (m === 0 && today.getUTCDate() < dob.getUTCDate())) age -= 1;
    return Math.max(0, age);
  }
  return person.age ?? null;
}

const present = (doc) => {
  if (!doc) return null;
  const h = doc.toObject ? doc.toObject() : doc;
  h.members = (h.members || []).map((m) => ({ ...m, age: ageOf(m) }));
  return h;
};

async function getOrCreate(ctx, unitId) {
  return Household.findOneAndUpdate(
    { society: ctx.societyId, unit: unitId },
    { $setOnInsert: { society: ctx.societyId, unit: unitId } },
    { upsert: true, returnDocument: 'after' },
  );
}

// Upload ids -> attachment objects; null clears the field.
async function resolveFiles(ctx, data) {
  const out = { ...data };
  for (const field of FILE_FIELDS) {
    if (out[field] === undefined) continue;
    if (out[field] === null) out[field] = undefined;
    else [out[field]] = await uploads.resolve(ctx, [out[field]]);
  }
  for (const k of ['bloodGroup', 'dob', 'age', 'vaccinationDate']) if (out[k] === null) out[k] = undefined;
  return out;
}

async function residentsOf(societyId, unitId) {
  const ms = await Membership.find({ society: societyId, unit: unitId, role: ROLES.RESIDENT, status: 'active' })
    .populate('user', 'name phone')
    .select('user residentType')
    .lean();
  return ms.filter((m) => m.user).map((m) => ({ membership: m._id, user: m.user._id, name: m.user.name, phone: m.user.phone, residentType: m.residentType }));
}

// ---------- resident (own unit) ----------
export async function getMine(ctx) {
  const unitId = requireUnit(ctx);
  const [doc, unit, residents] = await Promise.all([
    Household.findOne({ society: ctx.societyId, unit: unitId }).lean(),
    Unit.findById(unitId).select('label occupancy').lean(),
    residentsOf(ctx.societyId, unitId),
  ]);
  const h = present(doc) || { ...EMPTY, unit: unitId };
  const medical = (h.residentMedical || []).find((r) => String(r.user) === String(ctx.userId)) || null;
  return { ...h, unit, residents, myMedical: medical };
}

export async function updateMine(ctx, data) {
  const unitId = requireUnit(ctx);
  const doc = await getOrCreate(ctx, unitId);
  if (data.emergencyContacts) doc.emergencyContacts = data.emergencyContacts;
  if ('medicalNotes' in data) doc.medicalNotes = data.medicalNotes;
  doc.updatedBy = ctx.userId;
  await doc.save();
  return getMine(ctx);
}

export async function setMyMedical(ctx, data) {
  const unitId = requireUnit(ctx);
  const doc = await getOrCreate(ctx, unitId);
  const clean = await resolveFiles(ctx, data);
  const existing = doc.residentMedical.find((r) => String(r.user) === String(ctx.userId));
  if (existing) Object.assign(existing, clean);
  else doc.residentMedical.push({ user: ctx.userId, ...clean });
  doc.updatedBy = ctx.userId;
  await doc.save();
  return getMine(ctx);
}

const LISTS = { members: 'members', pets: 'pets' };

export async function addItem(ctx, list, data) {
  const unitId = requireUnit(ctx);
  const doc = await getOrCreate(ctx, unitId);
  if (doc[LISTS[list]].length >= 20) throw ApiError.badRequest(`At most 20 ${list} per home`);
  doc[LISTS[list]].push(await resolveFiles(ctx, data));
  doc.updatedBy = ctx.userId;
  await doc.save();
  audit.record(ctx, `household.${list}_added`, 'Household', doc._id, { name: data.name });
  return getMine(ctx);
}

export async function updateItem(ctx, list, itemId, data) {
  const unitId = requireUnit(ctx);
  const doc = await Household.findOne({ society: ctx.societyId, unit: unitId });
  const item = doc?.[LISTS[list]].id(itemId);
  if (!item) throw ApiError.notFound('Entry not found');
  Object.assign(item, await resolveFiles(ctx, data));
  doc.updatedBy = ctx.userId;
  await doc.save();
  return getMine(ctx);
}

export async function removeItem(ctx, list, itemId) {
  const unitId = requireUnit(ctx);
  const res = await Household.updateOne({ society: ctx.societyId, unit: unitId }, { $pull: { [LISTS[list]]: { _id: itemId } }, updatedBy: ctx.userId });
  if (!res.modifiedCount) throw ApiError.notFound('Entry not found');
  return getMine(ctx);
}

// ---------- admin / facility manager ----------
const summarise = (h) => ({
  members: h?.members?.length || 0,
  pets: h?.pets?.length || 0,
  emergencyContacts: h?.emergencyContacts?.length || 0,
  elderly: [...(h?.members || []), ...(h?.residentMedical || [])].filter((p) => p.elderly).length,
  specialNeeds: [...(h?.members || []), ...(h?.residentMedical || [])].filter((p) => p.specialNeeds).length,
  updatedAt: h?.updatedAt || null,
});

// Every unit with a short household summary, so managers also see homes that never filled a profile.
export async function list(ctx, filters, { page, limit, skip }) {
  const filter = { society: ctx.societyId };
  if (filters.search) filter.label = { $regex: escapeRegex(filters.search), $options: 'i' };
  if (filters.medicalOnly) {
    const flagged = await Household.find({
      society: ctx.societyId,
      $or: [{ 'members.elderly': true }, { 'members.specialNeeds': true }, { 'residentMedical.elderly': true }, { 'residentMedical.specialNeeds': true }],
    }).distinct('unit');
    filter._id = { $in: flagged };
  }
  const [units, total] = await Promise.all([
    Unit.find(filter).sort({ label: 1 }).skip(skip).limit(limit).select('label occupancy').lean(),
    Unit.countDocuments(filter),
  ]);
  const households = await Household.find({ society: ctx.societyId, unit: { $in: units.map((u) => u._id) } }).lean();
  const byUnit = new Map(households.map((h) => [String(h.unit), h]));
  const items = units.map((u) => ({ unit: u, ...summarise(byUnit.get(String(u._id))) }));
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getForUnit(ctx, unitId) {
  const unit = await Unit.findOne({ _id: unitId, society: ctx.societyId }).select('label occupancy').lean();
  if (!unit) throw ApiError.notFound('Unit not found');
  const [doc, residents] = await Promise.all([Household.findOne({ society: ctx.societyId, unit: unitId }).lean(), residentsOf(ctx.societyId, unitId)]);
  return { ...(present(doc) || { ...EMPTY }), unit, residents };
}

// ---------- emergency responders ----------
const ACTIVE_SOS = ['active', 'acknowledged'];
const medicalOf = (p) => ({ bloodGroup: p.bloodGroup, allergies: p.allergies, conditions: p.conditions, elderly: Boolean(p.elderly), specialNeeds: Boolean(p.specialNeeds) });

// What a guard needs while responding to an SOS from a home. Only available while the alert is open,
// so medical details are not browsable outside emergencies. Every read is audited.
export async function sosContext(ctx, sosId) {
  const alert = await SosAlert.findOne({ _id: sosId, society: ctx.societyId }).populate('raisedBy', 'name phone').lean();
  if (!alert) throw ApiError.notFound('SOS alert not found');
  if (ctx.role === ROLES.GUARD && !ACTIVE_SOS.includes(alert.status)) throw ApiError.forbidden('Emergency details are available only while the alert is open');
  const base = { alert: { _id: alert._id, type: alert.type, status: alert.status, location: alert.location, message: alert.message, createdAt: alert.createdAt, raisedBy: alert.raisedBy } };
  if (!alert.unit) return { ...base, unit: null, residents: [], members: [], pets: [], emergencyContacts: [] };

  const [unit, doc, residents] = await Promise.all([
    Unit.findById(alert.unit).select('label').lean(),
    Household.findOne({ society: ctx.societyId, unit: alert.unit }).lean(),
    residentsOf(ctx.societyId, alert.unit),
  ]);
  const medByUser = new Map((doc?.residentMedical || []).map((r) => [String(r.user), r]));
  audit.record(ctx, 'household.emergency_viewed', 'SosAlert', alert._id, { unit: unit?.label });
  return {
    ...base,
    unit,
    residents: residents.map((r) => ({ name: r.name, phone: r.phone, residentType: r.residentType, ...medicalOf(medByUser.get(String(r.user)) || {}) })),
    members: (doc?.members || []).map((m) => ({ name: m.name, relation: m.relation, age: ageOf(m), phone: m.phone, photo: m.photo, ...medicalOf(m) })),
    pets: (doc?.pets || []).map((p) => ({ name: p.name, type: p.type, breed: p.breed })),
    emergencyContacts: doc?.emergencyContacts || [],
    medicalNotes: doc?.medicalNotes,
  };
}

