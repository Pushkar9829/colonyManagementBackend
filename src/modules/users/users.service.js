import mongoose from 'mongoose';
import User from './user.model.js';
import Membership from './membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { ROLES } from '../../common/constants/index.js';
import * as units from '../units/units.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

// "Members" = memberships of this society joined with the person's account details.

export async function assertIdentifiersFree({ email, phone }, excludeId) {
  const or = [];
  if (email) or.push({ email });
  if (phone) or.push({ phone });
  if (!or.length) return;
  const clash = await User.findOne({ $or: or, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select('email phone').lean();
  if (clash) throw ApiError.conflict(clash.email === email ? 'Email is already registered' : 'Phone is already registered');
}

const present = (m) => ({
  _id: m._id,
  user: m.user?._id ?? m.user,
  name: m.user?.name,
  email: m.user?.email,
  phone: m.user?.phone,
  lastLoginAt: m.user?.lastLoginAt,
  role: m.role,
  residentType: m.residentType,
  designation: m.designation,
  unit: m.unit?.label ? { _id: m.unit._id, label: m.unit.label } : m.unit || null,
  status: m.status,
  createdAt: m.createdAt,
});

export async function list(ctx, filters, { page, limit, skip }) {
  const match = { society: new mongoose.Types.ObjectId(String(ctx.societyId)), support: { $ne: true } };
  if (filters.role) match.role = filters.role;
  if (filters.status) match.status = filters.status;
  if (filters.unit) match.unit = new mongoose.Types.ObjectId(filters.unit);
  const pipeline = [
    { $match: match },
    { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'user', pipeline: [{ $project: { name: 1, email: 1, phone: 1, lastLoginAt: 1 } }] } },
    { $unwind: '$user' },
  ];
  if (filters.search) {
    const rx = { $regex: escapeRegex(filters.search), $options: 'i' };
    pipeline.push({ $match: { $or: [{ 'user.name': rx }, { 'user.email': rx }, { 'user.phone': rx }] } });
  }
  pipeline.push(
    { $lookup: { from: 'units', localField: 'unit', foreignField: '_id', as: 'unit', pipeline: [{ $project: { label: 1 } }] } },
    { $unwind: { path: '$unit', preserveNullAndEmptyArrays: true } },
    { $sort: { createdAt: -1 } },
    { $facet: { items: [{ $skip: skip }, { $limit: limit }], total: [{ $count: 'n' }] } },
  );
  const [res] = await Membership.aggregate(pipeline);
  const total = res.total[0]?.n || 0;
  return { items: res.items.map(present), meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

async function getDoc(ctx, id) {
  const m = await Membership.findOne({ _id: id, society: ctx.societyId });
  if (!m) throw ApiError.notFound('Member not found');
  return m;
}

export async function getById(ctx, id) {
  const m = await Membership.findOne({ _id: id, society: ctx.societyId }).populate('user', 'name email phone lastLoginAt').populate('unit', 'label').lean();
  if (!m) throw ApiError.notFound('Member not found');
  return present(m);
}

// True when the person has no membership in any other society — only then may this society's admin
// edit their login details or reset their password.
async function ownedSolelyBy(ctx, userId) {
  return !(await Membership.exists({ user: userId, society: { $ne: ctx.societyId } }));
}

// Adds a person to the society. If an account already exists for the email/phone it is reused
// (no password change); otherwise a new account is created with the given password.
export async function create(ctx, { password, name, email, phone, ...data }) {
  if (data.role === ROLES.RESIDENT) await units.assertUnit(ctx.societyId, data.unit);
  else {
    delete data.unit;
    delete data.residentType;
  }

  const matches = await User.find({ $or: [email && { email }, phone && { phone }].filter(Boolean) }).select('_id').lean();
  if (matches.length > 1) throw ApiError.conflict('This email and phone belong to two different accounts');
  let userId = matches[0]?._id;
  let createdAccount = false;
  if (!userId) {
    if (!password) throw ApiError.validation([{ field: 'body.password', message: 'Password is required for a new account' }]);
    const user = await User.create({ name, email, phone, passwordHash: await User.hashPassword(password) });
    userId = user._id;
    createdAccount = true;
  }

  const unit = data.unit || null;
  const existing = await Membership.findOne({ user: userId, society: ctx.societyId, unit }).lean();
  if (existing) throw ApiError.conflict(unit ? 'This person is already linked to that unit' : 'This person already has a staff role in this society');

  const membership = await Membership.create({ ...data, user: userId, society: ctx.societyId, status: 'active' });
  if (membership.unit) await units.refreshOccupancy(ctx.societyId, membership.unit);
  audit.record(ctx, 'member.added', 'Membership', membership._id, { role: membership.role, newAccount: createdAccount });
  if (!createdAccount) {
    await notifyUsers(ctx.societyId, [userId], { type: 'account', title: 'You were added to a society', body: 'Switch to it from the society menu.', link: '/' });
  }
  return getById(ctx, membership._id);
}

export async function update(ctx, id, { name, email, phone, ...data }) {
  const m = await getDoc(ctx, id);
  const isSelf = String(m.user) === String(ctx.userId);
  if (isSelf && (data.role || data.status)) throw ApiError.badRequest('You cannot change your own role or status');

  if (name || email || phone) {
    if (!isSelf && !(await ownedSolelyBy(ctx, m.user))) {
      throw ApiError.forbidden('This person also belongs to another society, so only they can change their name, email or phone');
    }
    await assertIdentifiersFree({ email, phone }, m.user);
    await User.updateOne({ _id: m.user }, { $set: Object.fromEntries(Object.entries({ name, email, phone }).filter(([, v]) => v !== undefined)) });
  }

  const nextRole = data.role ?? m.role;
  const nextUnit = data.unit === undefined ? m.unit : data.unit;
  if (nextRole === ROLES.RESIDENT) {
    if (!nextUnit) throw ApiError.badRequest('Residents must be linked to a unit');
    await units.assertUnit(ctx.societyId, nextUnit);
  }
  const previousUnit = m.unit;
  Object.assign(m, data);
  if (nextRole !== ROLES.RESIDENT) {
    m.unit = undefined;
    m.residentType = undefined;
  }
  await m.save();
  await Promise.all([units.refreshOccupancy(ctx.societyId, previousUnit), units.refreshOccupancy(ctx.societyId, m.unit)]);
  audit.record(ctx, 'member.updated', 'Membership', m._id, { ...data, name, email, phone });
  return getById(ctx, m._id);
}

export async function setApproval(ctx, id, approve) {
  const m = await getDoc(ctx, id);
  if (m.status !== 'pending') throw ApiError.badRequest('Only pending requests can be approved or rejected');
  m.status = approve ? 'active' : 'rejected';
  await m.save();
  await units.refreshOccupancy(ctx.societyId, m.unit);
  audit.record(ctx, approve ? 'member.approved' : 'member.rejected', 'Membership', m._id);
  if (approve) {
    await notifyUsers(ctx.societyId, [m.user], { type: 'account', title: 'Your request is approved', body: 'Welcome to the society app.', link: '/' });
  }
  return getById(ctx, m._id);
}

export async function resetPassword(ctx, id, password) {
  const m = await getDoc(ctx, id);
  if (!(await ownedSolelyBy(ctx, m.user))) {
    throw ApiError.forbidden('This person also belongs to another society. Ask them to use "Forgot password" / SMS login instead.');
  }
  await User.updateOne({ _id: m.user }, { passwordHash: await User.hashPassword(password) });
  audit.record(ctx, 'member.password_reset', 'Membership', m._id);
}
