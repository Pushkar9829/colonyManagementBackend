import crypto from 'node:crypto';
import ApiError from '../../common/errors/ApiError.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { paginate } from '../../common/utils/pagination.js';
import User from '../users/user.model.js';
import RefreshToken from '../auth/refreshToken.model.js';
import { sendPlatformInvite } from '../auth/password.service.js';
import PlatformRole from './platformRole.model.js';
import PlatformAudit from './platformAudit.model.js';
import { PERMISSION_GROUPS, SYSTEM_ROLES } from './permissions.js';
import { OWNER, STAFF, activeOwnersFilter, ensureSystemRoles, isOwner } from './access.js';
import { recordPlatform } from './platformAudit.js';

const sameId = (a, b) => String(a) === String(b);
const isDuplicate = (err) => err?.code === 11000;

export const catalogue = () => ({ groups: PERMISSION_GROUPS, systemRoles: SYSTEM_ROLES.map((r) => r.key) });

// ---------- roles ----------
export async function listRoles() {
  await ensureSystemRoles();
  const [roles, counts, owners] = await Promise.all([
    PlatformRole.find().lean(),
    User.aggregate([{ $match: { platformRole: STAFF, platformRoleId: { $ne: null } } }, { $group: { _id: '$platformRoleId', n: { $sum: 1 } } }]),
    User.countDocuments({ platformRole: OWNER }),
  ]);
  const byRole = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  const order = SYSTEM_ROLES.map((r) => r.key);
  return roles
    .map((r) => ({ ...r, memberCount: r.key === 'owner' ? owners : byRole[String(r._id)] || 0 }))
    .sort((a, b) => (a.system === b.system ? (a.system ? order.indexOf(a.key) - order.indexOf(b.key) : a.name.localeCompare(b.name)) : a.system ? -1 : 1));
}

async function findRole(id) {
  await ensureSystemRoles();
  const role = await PlatformRole.findById(id).lean();
  if (!role) throw ApiError.notFound('Role not found');
  return role;
}

// Nobody but an owner may hand out powers they don't hold themselves.
function assertCanGrant(ctx, permissions, { owner = false } = {}) {
  if (isOwner(ctx.user)) return;
  if (owner) throw ApiError.forbidden('Only an owner can make someone an owner');
  const held = ctx.user.platformPermissions || [];
  const missing = permissions.filter((p) => !held.includes(p));
  if (missing.length) throw ApiError.forbidden("You can't grant permissions you don't have: {permissions}", { params: { permissions: missing.join(', ') } });
}

export async function createRole(ctx, data) {
  assertCanGrant(ctx, data.permissions);
  await ensureSystemRoles();
  try {
    const role = await PlatformRole.create({ ...data, permissions: [...new Set(data.permissions)], system: false, createdBy: ctx.userId });
    recordPlatform(ctx, 'role.created', { targetType: 'PlatformRole', targetId: role._id, details: { name: role.name, permissions: role.permissions } });
    return role.toObject();
  } catch (err) {
    if (isDuplicate(err)) throw ApiError.conflict('A role with this name already exists');
    throw err;
  }
}

export async function updateRole(ctx, id, data) {
  const role = await findRole(id);
  if (role.system) throw ApiError.forbidden('Built-in roles cannot be changed. Duplicate it as a custom role instead.');
  if (data.permissions) assertCanGrant(ctx, data.permissions);
  const set = { ...data, ...(data.permissions ? { permissions: [...new Set(data.permissions)] } : {}) };
  try {
    const updated = await PlatformRole.findByIdAndUpdate(id, { $set: set }, { returnDocument: 'after', runValidators: true }).lean();
    recordPlatform(ctx, 'role.updated', { targetType: 'PlatformRole', targetId: id, details: { name: updated.name, ...data } });
    return updated;
  } catch (err) {
    if (isDuplicate(err)) throw ApiError.conflict('A role with this name already exists');
    throw err;
  }
}

export async function deleteRole(ctx, id) {
  const role = await findRole(id);
  if (role.system) throw ApiError.forbidden('Built-in roles cannot be deleted');
  const assigned = await User.countDocuments({ platformRole: STAFF, platformRoleId: role._id });
  if (assigned) throw ApiError.conflict(assigned === 1 ? '{n} member has this role. Give them another role first.' : '{n} members have this role. Give them another role first.', { params: { n: assigned } });
  await PlatformRole.deleteOne({ _id: role._id });
  recordPlatform(ctx, 'role.deleted', { targetType: 'PlatformRole', targetId: id, details: { name: role.name } });
}

// ---------- members ----------
const MEMBER_FIELDS = 'name email phone status platformRole platformRoleId platformStatus platformAddedAt lastLoginAt';

function shapeMember(u, rolesById) {
  const role = u.platformRole === OWNER ? rolesById.owner : rolesById[String(u.platformRoleId)];
  return {
    _id: u._id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: role ? { _id: role._id, name: role.name, key: role.key, system: role.system } : null,
    owner: u.platformRole === OWNER,
    // Switched off on the platform, or the whole account is inactive.
    status: u.status !== 'active' || u.platformStatus === 'inactive' ? 'inactive' : 'active',
    lastLoginAt: u.lastLoginAt,
    addedAt: u.platformAddedAt || u.createdAt,
  };
}

async function rolesIndex() {
  const roles = await PlatformRole.find().select('name key system').lean();
  const index = Object.fromEntries(roles.map((r) => [String(r._id), r]));
  index.owner = roles.find((r) => r.key === 'owner');
  return index;
}

export async function listMembers(filters, pagination) {
  await ensureSystemRoles();
  const filter = { platformRole: { $in: [OWNER, STAFF] } };
  if (filters.status === 'inactive') filter.$or = [{ platformStatus: 'inactive' }, { status: { $ne: 'active' } }];
  if (filters.status === 'active') Object.assign(filter, { platformStatus: { $ne: 'inactive' }, status: 'active' });
  if (filters.search) {
    const rx = { $regex: escapeRegex(filters.search), $options: 'i' };
    filter.$and = [{ $or: [{ name: rx }, { email: rx }] }];
  }
  const [{ items, meta }, index] = await Promise.all([paginate(User, filter, pagination, { sort: { name: 1 }, select: MEMBER_FIELDS + ' createdAt' }), rolesIndex()]);
  return { items: items.map((u) => shapeMember(u, index)), meta };
}

async function loadMember(id) {
  const user = await User.findOne({ _id: id, platformRole: { $in: [OWNER, STAFF] } }).select(MEMBER_FIELDS).lean();
  if (!user) throw ApiError.notFound('Platform member not found');
  return user;
}

async function memberView(id) {
  const user = await User.findById(id).select(MEMBER_FIELDS + ' createdAt').lean();
  return shapeMember(user, await rolesIndex());
}

// At least one active owner must always remain.
async function assertAnotherActiveOwner(target) {
  if (!isOwner(target)) return;
  const others = await User.countDocuments({ ...activeOwnersFilter(), _id: { $ne: target._id } });
  if (!others) throw ApiError.conflict('This is the last active owner. Make someone else an owner first.');
}

function assertNotSelf(ctx, target, what) {
  if (sameId(ctx.userId, target._id)) throw ApiError.badRequest("You can't {action} yourself. Ask another owner or team manager.", { params: { action: what } });
}

function assertCanTouch(ctx, target) {
  if (isOwner(target) && !isOwner(ctx.user)) throw ApiError.forbidden('Only an owner can change another owner');
}

// Ends the member's platform sessions (society sessions are left alone). Access tokens already stop working on
// the next request, because the principal re-reads permissions every time.
const endPlatformSessions = (userId) => {
  const now = new Date();
  return RefreshToken.updateMany({ user: userId, membership: null, expiresAt: { $gt: now } }, { revokedAt: now, expiresAt: now });
};

const roleFields = (role) => (role.key === 'owner' ? { platformRole: OWNER, platformRoleId: null } : { platformRole: STAFF, platformRoleId: role._id });

export async function inviteMember(ctx, { name, email, roleId }) {
  const role = await findRole(roleId);
  assertCanGrant(ctx, role.permissions, { owner: role.key === 'owner' });
  const existing = await User.findOne({ email }).select(MEMBER_FIELDS).lean();
  if (existing?.platformRole) throw ApiError.conflict('This person is already on the platform team');
  if (existing && existing.status !== 'active') throw ApiError.conflict('This account is not active');

  const fields = { ...roleFields(role), platformStatus: 'active', platformAddedAt: new Date() };
  let user;
  let inviteLink = null;
  if (existing) {
    // Someone who already uses ColonyHub (e.g. a society admin) keeps their password and simply gains access.
    await User.updateOne({ _id: existing._id }, { $set: fields });
    user = existing;
  } else {
    // Random password nobody knows; the member chooses their own through the invite link.
    const passwordHash = await User.hashPassword(crypto.randomBytes(24).toString('base64url'));
    try {
      user = await User.create({ name, email, passwordHash, ...fields });
    } catch (err) {
      if (isDuplicate(err)) throw ApiError.conflict('An account with this email already exists');
      throw err;
    }
    inviteLink = await sendPlatformInvite(user._id, role.name);
  }
  recordPlatform(ctx, 'team.member_invited', { targetType: 'User', targetId: user._id, details: { name: user.name, email, role: role.name, existingAccount: Boolean(existing) } });
  return { member: await memberView(user._id), existingAccount: Boolean(existing), ...(inviteLink ? { inviteLink } : {}) };
}

export async function changeRole(ctx, id, roleId) {
  const target = await loadMember(id);
  assertNotSelf(ctx, target, 'change the role of');
  assertCanTouch(ctx, target);
  const role = await findRole(roleId);
  assertCanGrant(ctx, role.permissions, { owner: role.key === 'owner' });
  if (role.key !== 'owner') await assertAnotherActiveOwner(target);
  const before = isOwner(target) ? 'Owner' : (await PlatformRole.findById(target.platformRoleId).select('name').lean())?.name;
  await User.updateOne({ _id: target._id }, { $set: roleFields(role) });
  recordPlatform(ctx, 'team.member_role_changed', { targetType: 'User', targetId: target._id, details: { name: target.name, from: before, to: role.name } });
  return memberView(target._id);
}

export async function setActive(ctx, id, active) {
  const target = await loadMember(id);
  assertNotSelf(ctx, target, active ? 'reactivate' : 'deactivate');
  assertCanTouch(ctx, target);
  if (!active) await assertAnotherActiveOwner(target);
  await User.updateOne({ _id: target._id }, { $set: { platformStatus: active ? 'active' : 'inactive' } });
  if (!active) await endPlatformSessions(target._id);
  recordPlatform(ctx, active ? 'team.member_reactivated' : 'team.member_deactivated', { targetType: 'User', targetId: target._id, details: { name: target.name } });
  return memberView(target._id);
}

// Takes platform access away; the account itself (and any society memberships) stays.
export async function removeMember(ctx, id) {
  const target = await loadMember(id);
  assertNotSelf(ctx, target, 'remove');
  assertCanTouch(ctx, target);
  await assertAnotherActiveOwner(target);
  await User.updateOne({ _id: target._id }, { $unset: { platformRole: 1, platformRoleId: 1, platformStatus: 1, platformAddedAt: 1 } });
  await endPlatformSessions(target._id);
  recordPlatform(ctx, 'team.member_removed', { targetType: 'User', targetId: target._id, details: { name: target.name, email: target.email } });
}

// ---------- activity log ----------
export function activity(filters, pagination) {
  const filter = {};
  if (filters.actor) filter.actor = filters.actor;
  if (filters.society) filter.society = filters.society;
  if (filters.action) filter.action = { $regex: `^${escapeRegex(filters.action)}(\\.|$)` };
  if (filters.from || filters.to) filter.at = { ...(filters.from ? { $gte: filters.from } : {}), ...(filters.to ? { $lte: filters.to } : {}) };
  return paginate(PlatformAudit, filter, pagination, {
    sort: { at: -1, _id: -1 },
    populate: [
      { path: 'actor', select: 'name email' },
      { path: 'society', select: 'name code' },
    ],
  });
}

// Current members plus anyone who appears in the log (removed members too), for the "who" filter.
export async function actors() {
  const logged = await PlatformAudit.distinct('actor');
  return User.find({ $or: [{ platformRole: { $in: [OWNER, STAFF] } }, { _id: { $in: logged } }] }).select('name email').sort({ name: 1 }).lean();
}
