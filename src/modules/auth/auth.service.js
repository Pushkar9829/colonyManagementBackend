import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { withTransaction } from '../../common/utils/transaction.js';
import env from '../../config/env.js';
import ApiError from '../../common/errors/ApiError.js';
import { sha256 } from '../../common/utils/codes.js';
import { addDays } from '../../common/utils/dates.js';
import { PLANS, ROLES } from '../../common/constants/index.js';
import User from '../users/user.model.js';
import Membership from '../users/membership.model.js';
import Society from '../society/society.model.js';
import Block from '../units/block.model.js';
import Unit from '../units/unit.model.js';
import RefreshToken from './refreshToken.model.js';
import * as otp from './otp.service.js';
import * as mfa from './mfa.service.js';
import * as societyService from '../society/society.service.js';
import * as usersService from '../users/users.service.js';
import { defaultMembership } from '../users/principal.js';
import { USER_PLATFORM_FIELDS, permissionsFor } from '../platformTeam/access.js';
import PlatformRole from '../platformTeam/platformRole.model.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';
import * as paymentSettings from '../paymentSettings/paymentSettings.service.js';
import * as whitelabel from '../whitelabel/whitelabel.service.js';
import logger from '../../common/utils/logger.js';

const REUSE_GRACE_MS = 60 * 1000;
const TRIAL_DAYS = 30;
const expired = () => new ApiError(401, 'REFRESH_INVALID', 'Session expired, please log in again');

// ---------- tokens & sessions ----------
// Access token = who (sub) + which society membership is open (mid). mid is absent for platform sessions.
function signAccessToken(userId, membershipId) {
  return jwt.sign({ sub: String(userId), ...(membershipId ? { mid: String(membershipId) } : {}) }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
  });
}

async function issueRefreshToken(userId, membershipId, meta, family = crypto.randomUUID()) {
  const token = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({
    user: userId,
    membership: membershipId || undefined,
    tokenHash: sha256(token),
    family,
    expiresAt: addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS),
    userAgent: meta.userAgent?.slice(0, 200),
    ip: meta.ip,
  });
  return token;
}

async function sessionFor(userId, membershipId, meta, family) {
  return {
    accessToken: signAccessToken(userId, membershipId),
    refreshToken: await issueRefreshToken(userId, membershipId, meta, family),
    user: await profile(userId, membershipId),
  };
}

const MEMBERSHIP_POPULATE = [
  { path: 'society', select: 'name code city active' },
  { path: 'unit', select: 'label block' },
];

// The signed-in person, the membership currently open, and every membership they can switch to.
export async function profile(userId, membershipId) {
  const { mfa: mfaState, ...user } = (await User.findById(userId).select(`name email phone notificationPrefs lastLoginAt mfa.enabled reseller ${USER_PLATFORM_FIELDS}`).lean()) || {};
  if (!user._id) throw ApiError.notFound('User not found');
  const memberships = await Membership.find({
    user: userId,
    status: { $in: ['active', 'pending'] },
    $or: [{ support: { $ne: true } }, { expiresAt: { $gt: new Date() } }],
  })
    .populate(MEMBERSHIP_POPULATE)
    .sort({ createdAt: 1 })
    .lean();
  const current = memberships.find((m) => String(m._id) === String(membershipId));
  const mfaEnabled = Boolean(mfaState?.enabled);
  // Platform team: what the console may show (null for everyone else). The role name is for display only.
  const platformPermissions = await permissionsFor(user);
  const platformRoleName = platformPermissions
    ? user.platformRole === 'super_admin'
      ? 'Owner'
      : (await PlatformRole.findById(user.platformRoleId).select('name').lean())?.name
    : undefined;
  return {
    ...user,
    platformPermissions,
    platformRoleName,
    mfaEnabled,
    mfaSetupRequired: !mfaEnabled && (await societyRequiresMfa(current)),
    // flat fields for the current context (what the UI reads everywhere)
    membershipId: current?._id || null,
    // reseller_admin: a white-label partner's console session (no society, no platform permissions)
    role: current ? current.role : !platformPermissions && user.reseller ? 'reseller_admin' : ROLES.SUPER_ADMIN,
    society: current?.society || null,
    unit: current?.unit || null,
    residentType: current?.residentType,
    designation: current?.designation,
    memberships: memberships.map((m) => ({
      _id: m._id,
      role: m.role,
      status: m.status,
      residentType: m.residentType,
      designation: m.designation,
      society: m.society,
      unit: m.unit,
      support: m.support || undefined,
      expiresAt: m.support ? m.expiresAt : undefined,
    })),
  };
}

// Society policy: admins and accountants must use two-step verification. Platform support sessions are governed
// by the platform, not the society, so they are exempt.
const MFA_POLICY_ROLES = [ROLES.ADMIN, ROLES.ACCOUNTANT];
async function societyRequiresMfa(membership) {
  if (!membership || membership.support || !MFA_POLICY_ROLES.includes(membership.role)) return false;
  const society = await Society.findById(membership.society?._id || membership.society).select('settings.security').lean();
  return Boolean(society?.settings?.security?.requireMfa);
}

// Chooses where a user lands after authenticating. With two-step verification on, the first factor only earns a
// short-lived mfaToken; POST /auth/mfa/verify finishes the login.
async function loginUser(user, meta, { via, secondFactorDone = false } = {}) {
  if (user.status !== 'active') throw new ApiError(403, 'ACCOUNT_INACTIVE', 'Your account is not active');
  const membership = await defaultMembership(user);
  if (!membership && !user.reseller && !(await permissionsFor(user))) {
    if (user.platformRole && user.platformStatus === 'inactive') throw new ApiError(403, 'PLATFORM_ACCESS_OFF', 'Your platform team access has been switched off');
    const pending = await Membership.exists({ user: user._id, status: 'pending' });
    if (pending) throw new ApiError(403, 'PENDING_APPROVAL', 'Your request is waiting for society admin approval');
    throw new ApiError(403, 'NO_MEMBERSHIP', 'Your account is not linked to any active society');
  }
  if (!secondFactorDone && (await mfa.isEnabled(user._id))) return mfa.issueChallenge(user._id, via);
  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date(), lastMembership: membership?._id });
  return sessionFor(user._id, membership?._id, meta);
}

export async function login({ identifier, password }, meta) {
  const id = identifier.toLowerCase();
  const user = await User.findOne(id.includes('@') ? { email: id } : { phone: identifier }).select('+passwordHash');
  // Same message for unknown user and wrong password to avoid account enumeration.
  if (!user || !(await user.verifyPassword(password))) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  return loginUser(user, meta, { via: 'password' });
}

export async function loginWithOtp({ phone, code }, meta) {
  return loginUser(await otp.verifyLoginOtp(phone, code), meta, { via: 'otp' });
}

export async function loginWithMfa({ mfaToken, code, backupCode }, meta) {
  const userId = await mfa.verifyChallenge(mfaToken, { code, backupCode });
  const user = await User.findById(userId);
  if (!user) throw new ApiError(401, 'MFA_TOKEN_INVALID', 'Your sign-in has expired. Please log in again.');
  return loginUser(user, meta, { secondFactorDone: true });
}

export const requestOtp = ({ phone }) => otp.requestLoginOtp(phone);

// Opens another of the user's memberships (or the platform console for super admins).
export async function switchMembership(ctx, membershipId, meta) {
  if (membershipId) {
    const m = await Membership.findOne({ _id: membershipId, user: ctx.userId }).lean();
    if (!m) throw ApiError.notFound('Membership not found');
    if (m.status !== 'active') throw ApiError.forbidden(m.status === 'pending' ? 'This home is still waiting for approval' : 'This membership is not active');
  } else if (!ctx.user.platformPermissions && !ctx.user.reseller) {
    throw ApiError.forbidden('Choose a society');
  }
  await User.updateOne({ _id: ctx.userId }, { lastMembership: membershipId || undefined });
  return sessionFor(ctx.userId, membershipId, meta);
}

export async function refresh(token, meta) {
  const stored = await RefreshToken.findOne({ tokenHash: sha256(token) });
  if (!stored || stored.expiresAt <= new Date()) throw expired();
  // A token rotated moments ago is usually a benign race (page reload aborted the response,
  // two tabs refreshing at once). Allow it briefly; later reuse is treated as theft.
  const inGrace = stored.revokedAt && Date.now() - stored.revokedAt.getTime() < REUSE_GRACE_MS;
  if (stored.revokedAt && !inGrace) {
    const now = new Date();
    await RefreshToken.updateMany({ family: stored.family }, { revokedAt: now, expiresAt: now });
    throw new ApiError(401, 'REFRESH_REUSED', 'Session expired, please log in again');
  }
  const user = await User.findById(stored.user).lean();
  if (!user || user.status !== 'active') throw expired();

  // Keep the same society context if it is still valid; otherwise fall back to another membership.
  let membershipId = stored.membership;
  if (membershipId && !(await Membership.exists({ _id: membershipId, user: user._id, status: 'active' }))) {
    membershipId = (await defaultMembership(user))?._id;
    if (!membershipId && !user.reseller && !(await permissionsFor(user))) throw expired();
  }
  if (!membershipId && !stored.membership && !user.reseller && !(await permissionsFor(user))) throw expired();

  if (!stored.revokedAt) {
    stored.revokedAt = new Date();
    await stored.save();
  }
  return sessionFor(user._id, membershipId, meta, stored.family);
}

export async function logout(token) {
  if (!token) return;
  // Kill the whole device session (family) and expire it so the reuse grace window can't revive it.
  const stored = await RefreshToken.findOne({ tokenHash: sha256(token) }).lean();
  if (!stored) return;
  const now = new Date();
  await RefreshToken.updateMany({ family: stored.family }, { revokedAt: now, expiresAt: now });
}

// ---------- onboarding ----------
export async function registerSociety({ society: societyData, admin, licenceKey }, meta) {
  await usersService.assertIdentifiersFree(admin);
  // A white-label licence key is checked before anything is created, so a bad key creates nothing.
  if (licenceKey) await whitelabel.assertKeyUsable(licenceKey);
  const code = await societyService.generateUniqueCode();
  const passwordHash = await User.hashPassword(admin.password);
  const { society, user, membership } = await withTransaction(async (session) => {
    // New societies get a full-featured trial; afterwards they fall back to the free plan until they subscribe.
    const plan = { name: 'trial', unitLimit: PLANS.trial.unitLimit, validUntil: new Date(Date.now() + TRIAL_DAYS * 86400000) };
    const [s] = await Society.create([{ ...societyData, code, contactEmail: admin.email, plan }], { session });
    const { password: _password, designation, ...adminData } = admin;
    const [u] = await User.create([{ ...adminData, passwordHash }], { session });
    const [m] = await Membership.create([{ user: u._id, society: s._id, role: ROLES.ADMIN, designation, status: 'active' }], { session });
    return { society: s, user: u, membership: m };
  });
  await User.updateOne({ _id: user._id }, { lastMembership: membership._id });
  audit.record({ societyId: society._id, userId: user._id, ip: meta.ip }, 'society.registered', 'Society', society._id);
  // Online payments start off: residents' money must go to the society's own account, set up in Settings.
  await paymentSettings.initForNewSociety(society._id);
  if (licenceKey) {
    const ctx = { societyId: society._id, userId: user._id, ip: meta.ip };
    await whitelabel.activateKey(ctx, licenceKey).catch((err) => logger.warn({ err: err.message, society: String(society._id) }, 'licence key could not be applied at registration'));
  }
  return sessionFor(user._id, membership._id, meta);
}

// Public: lets a resident pick their unit after entering the society code.
export async function lookupSociety(code) {
  const society = await societyService.findByCode(code);
  if (!society) throw ApiError.notFound('No society found for this code');
  const [blocks, units] = await Promise.all([
    Block.find({ society: society._id }).select('name').sort({ name: 1 }).lean(),
    Unit.find({ society: society._id }).select('label block').sort({ label: 1 }).lean(),
  ]);
  return { society: { _id: society._id, name: society.name, city: society.city }, blocks, units };
}

async function requestHome(userId, userName, { societyCode, unit: unitId, residentType }) {
  const society = await societyService.findByCode(societyCode);
  if (!society) throw ApiError.notFound('No society found for this code');
  const unit = await Unit.findOne({ _id: unitId, society: society._id }).lean();
  if (!unit) throw ApiError.badRequest('Unit not found in this society');
  const existing = await Membership.findOne({ user: userId, society: society._id, unit: unit._id }).lean();
  if (existing && ['active', 'pending'].includes(existing.status)) throw ApiError.conflict(existing.status === 'active' ? 'You already belong to {unit}' : 'You already requested {unit}', { params: { unit: unit.label } });
  if (existing) await Membership.deleteOne({ _id: existing._id }); // re-apply after a rejection
  const membership = await Membership.create({ user: userId, society: society._id, role: ROLES.RESIDENT, unit: unit._id, residentType, status: 'pending' });
  await notifyRoles(society._id, [ROLES.ADMIN], {
    type: 'account',
    title: 'New resident request',
    body: `${userName} requested access to ${unit.label}`,
    link: '/members?status=pending',
  });
  return membership;
}

// Public sign-up for a new person. Existing accounts add homes from inside the app instead.
export async function join(data) {
  const society = await societyService.findByCode(data.societyCode);
  if (!society) throw ApiError.notFound('No society found for this code');
  const unit = await Unit.findOne({ _id: data.unit, society: society._id }).lean();
  if (!unit) throw ApiError.badRequest('Unit not found in this society');
  try {
    await usersService.assertIdentifiersFree(data);
  } catch (err) {
    if (err.status === 409) throw ApiError.conflict(`${err.message}. Log in and use "Add another home" instead.`);
    throw err;
  }
  const user = await User.create({ name: data.name, email: data.email, phone: data.phone, passwordHash: await User.hashPassword(data.password) });
  await requestHome(user._id, user.name, data);
  return { status: 'pending', message: 'Request sent. You can log in once the society admin approves it.' };
}

// Logged-in user asks to join another flat (same or different society).
export async function addHome(ctx, data) {
  const m = await requestHome(ctx.userId, ctx.user.name, data);
  return { status: m.status, message: 'Request sent to the society admin.' };
}

// ---------- self service ----------
export async function updateMe(ctx, data) {
  const { notificationPrefs, ...rest } = data;
  if (rest.phone) await usersService.assertIdentifiersFree({ phone: rest.phone }, ctx.userId);
  const set = { ...rest };
  for (const [k, v] of Object.entries(notificationPrefs || {})) set[`notificationPrefs.${k}`] = v;
  await User.updateOne({ _id: ctx.userId }, { $set: set });
  return profile(ctx.userId, ctx.user.membershipId);
}

export async function changePassword(ctx, { currentPassword, newPassword, refreshToken }) {
  const user = await User.findById(ctx.userId).select('+passwordHash');
  if (!(await user.verifyPassword(currentPassword))) throw ApiError.badRequest('Current password is incorrect');
  user.passwordHash = await User.hashPassword(newPassword);
  await user.save();
  // Sign out other devices; keep the session that made the change (if it sent its refresh token).
  const keep = refreshToken ? { tokenHash: { $ne: sha256(refreshToken) } } : {};
  const now = new Date();
  await RefreshToken.updateMany({ user: user._id, expiresAt: { $gt: now }, ...keep }, { revokedAt: now, expiresAt: now });
}
