import PersonalDetails from './personalDetails.model.js';
import Unit from '../units/unit.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { requireMember } from '../directory/members.js';
import * as household from '../household/household.service.js';
import * as audit from '../audit/audit.service.js';

const FIELDS = ['dateOfBirth', 'anniversaryDate', 'gender', 'occupation'];

export const present = (doc) => ({
  dateOfBirth: doc?.dateOfBirth || null,
  anniversaryDate: doc?.anniversaryDate || null,
  gender: doc?.gender || null,
  occupation: doc?.occupation || null,
  updatedAt: doc?.updatedAt || null,
});

// userId -> details, for the directory and the celebrations module.
export async function detailsFor(societyId, userIds) {
  const rows = await PersonalDetails.find({ society: societyId, user: { $in: userIds } }).lean();
  return new Map(rows.map((r) => [String(r.user), r]));
}

async function save(ctx, userId, data) {
  let doc = await PersonalDetails.findOne({ society: ctx.societyId, user: userId });
  if (!doc) doc = new PersonalDetails({ society: ctx.societyId, user: userId });
  for (const k of FIELDS) if (data[k] !== undefined) doc.set(k, data[k] === null ? undefined : data[k]);
  if (doc.dateOfBirth && doc.anniversaryDate && doc.anniversaryDate <= doc.dateOfBirth) {
    throw ApiError.validation([{ field: 'body.anniversaryDate', message: 'Anniversary must be after the date of birth' }]);
  }
  doc.updatedBy = ctx.userId;
  await doc.save();
  return present(doc.toObject());
}

// ---------- the member themselves ----------
export async function getMine(ctx) {
  return present(await PersonalDetails.findOne({ society: ctx.societyId, user: ctx.userId }).lean());
}

export const updateMine = (ctx, data) => save(ctx, ctx.userId, data);

// ---------- society admin ----------
// Everyone living in a unit — residents with a login and family members without one — with their details.
export async function forUnit(ctx, unitId) {
  const unit = await Unit.findOne({ _id: unitId, society: ctx.societyId }).select('label').lean();
  if (!unit) throw ApiError.notFound('Unit not found');
  const [memberships, home] = await Promise.all([
    Membership.find({ society: ctx.societyId, unit: unitId, role: 'resident', status: 'active' }).populate('user', 'name phone').lean(),
    household.getForUnit(ctx, unitId),
  ]);
  const people = memberships.filter((m) => m.user);
  const details = await detailsFor(ctx.societyId, people.map((m) => m.user._id));
  return {
    unit,
    residents: people.map((m) => ({ user: m.user._id, name: m.user.name, phone: m.user.phone, residentType: m.residentType, ...present(details.get(String(m.user._id))) })),
    members: (home.members || []).map((m) => ({
      _id: m._id,
      name: m.name,
      relation: m.relation,
      phone: m.phone,
      dateOfBirth: m.dob || null,
      anniversaryDate: m.anniversaryDate || null,
      gender: m.gender || null,
      occupation: m.occupation || null,
      showBirthday: Boolean(m.showBirthday),
    })),
  };
}

export async function updateForUser(ctx, userId, data) {
  await requireMember(ctx.societyId, userId);
  const out = await save(ctx, userId, data);
  audit.record(ctx, 'people.details_updated', 'User', userId, { fields: Object.keys(data) });
  return out;
}

export const updateForFamilyMember = (ctx, unitId, memberId, data) => household.updateFamilyPersonal(ctx, unitId, memberId, data);
