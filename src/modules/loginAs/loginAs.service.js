import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import env from '../../config/env.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import { escapeRegex } from '../../common/utils/strings.js';
import User from '../users/user.model.js';
import Membership from '../users/membership.model.js';
import Society from '../society/society.model.js';
import LoginAsSession from './loginAsSession.model.js';
import LoginAsPolicy from './loginAsPolicy.model.js';
import { actingInfo, actingProfile } from './acting.js';
import { permissionsFor, USER_PLATFORM_FIELDS } from '../platformTeam/access.js';
import { recordPlatform } from '../platformTeam/platformAudit.js';
import * as audit from '../audit/audit.service.js';
import * as mfa from '../auth/mfa.service.js';
import { profile } from '../auth/auth.service.js';

export const DEFAULT_MINUTES = 30;
export const MAX_MINUTES = 120;
export const KINDS = ['platform', 'admin', 'subadmin'];
export const DEFAULT_POLICY = { platform: true, admin: true, subadmin: false };

// Levels, highest first. A person may only log in as someone on a strictly lower level.
const LEVEL = {
  [ROLES.ADMIN]: 1,
  [ROLES.ACCOUNTANT]: 2,
  [ROLES.FACILITY_MANAGER]: 2,
  [ROLES.GUARD]: 3,
  [ROLES.RESIDENT]: 3,
  [ROLES.STAFF]: 3,
};
const KIND_LEVEL = { platform: 0, admin: 1, subadmin: 2 };
const kindOfRole = (role) => (role === ROLES.ADMIN ? 'admin' : LEVEL[role] === 2 ? 'subadmin' : null);
// The roles each kind may view, for the UI.
export const targetsFor = (kind) => Object.keys(LEVEL).filter((r) => LEVEL[r] > KIND_LEVEL[kind]);

const PLATFORM_PERMS = ['support.access', 'impersonation.manage'];
const pick = (o) => ({ platform: o?.platform ?? null, admin: o?.admin ?? null, subadmin: o?.subadmin ?? null });

// ---------- policy ----------
async function globalPolicy() {
  const row = await LoginAsPolicy.findOne({ society: null }).lean();
  return Object.fromEntries(KINDS.map((k) => [k, row?.[k] ?? DEFAULT_POLICY[k]]));
}

export async function effectivePolicy(societyId) {
  const [global, override] = await Promise.all([globalPolicy(), LoginAsPolicy.findOne({ society: societyId }).lean()]);
  return Object.fromEntries(KINDS.map((k) => [k, override?.[k] ?? global[k]]));
}

export const getGlobalPolicy = async () => ({ policy: await globalPolicy(), defaults: DEFAULT_POLICY, overrides: await LoginAsPolicy.countDocuments({ society: { $ne: null } }) });

export async function setGlobalPolicy(ctx, data) {
  const $set = { updatedBy: ctx.userId };
  for (const k of KINDS) if (typeof data[k] === 'boolean') $set[k] = data[k];
  await LoginAsPolicy.updateOne({ society: null }, { $set }, { upsert: true });
  return getGlobalPolicy();
}

async function assertSociety(id) {
  const s = await Society.findById(id).select('name').lean();
  if (!s) throw ApiError.notFound('Society not found');
  return s;
}

export async function getSocietyPolicy(societyId) {
  const society = await assertSociety(societyId);
  const override = await LoginAsPolicy.findOne({ society: societyId }).lean();
  return { society: { _id: society._id, name: society.name }, override: pick(override), effective: await effectivePolicy(societyId), global: await globalPolicy() };
}

// Per-society override; null clears a field back to the platform rule. Logged in the society's own audit log
// too, so its admins can see who changed their access rules.
export async function setSocietyPolicy(ctx, societyId, data) {
  await assertSociety(societyId);
  const $set = { updatedBy: ctx.userId };
  for (const k of KINDS) if (k in data) $set[k] = data[k];
  await LoginAsPolicy.updateOne({ society: societyId }, { $set }, { upsert: true });
  audit.record({ societyId, userId: ctx.userId, ip: ctx.ip }, 'login_as.policy_changed', 'Society', societyId, pick(data));
  return getSocietyPolicy(societyId);
}

// What a society member may do (read-only view for admins / sub-admins).
export async function myRules(ctx) {
  const kind = kindOfRole(ctx.role);
  const policy = await effectivePolicy(ctx.societyId);
  return {
    policy,
    kind,
    allowed: Boolean(kind && policy[kind]),
    canTarget: kind && policy[kind] ? targetsFor(kind) : [],
    maxMinutes: MAX_MINUTES,
    defaultMinutes: DEFAULT_MINUTES,
  };
}

// ---------- who is asking ----------
// Platform team members count as "platform" in the console and inside a support session; anywhere else they
// act with the role of the membership they have open.
async function actorOf(user) {
  if (user.platformPermissions) {
    const supportSession = user.membershipId && (await Membership.exists({ _id: user.membershipId, support: true }));
    if (!user.society || supportSession) {
      if (!PLATFORM_PERMS.some((p) => user.platformPermissions.includes(p))) throw ApiError.forbidden('Your platform role cannot log in as members');
      return { kind: 'platform', level: 0 };
    }
  }
  if (!user.society) throw ApiError.forbidden('Open a society to use this');
  const kind = kindOfRole(user.role);
  if (!kind) throw ApiError.forbidden('Your role cannot log in as other members');
  return { kind, level: KIND_LEVEL[kind] };
}

const LEVEL_TEXT = { platform: 'the platform team', admin: 'society admins', subadmin: 'accountants and facility managers' };

async function loadTarget(actor, ctx, membershipId) {
  const m = await Membership.findById(membershipId).populate('unit', 'label').lean();
  // Society members only ever see their own society's memberships.
  if (!m || (actor.kind !== 'platform' && String(m.society) !== String(ctx.societyId))) throw ApiError.notFound('Member not found');
  if (m.support) throw ApiError.forbidden('You cannot log in as a platform support session');
  if (String(m.user) === String(ctx.userId)) throw ApiError.badRequest('You cannot log in as yourself');
  if (m.status !== 'active') throw ApiError.forbidden('This membership is not active');
  if (!(LEVEL[m.role] > actor.level)) throw ApiError.forbidden('You can only log in as people below your level');
  const user = await User.findById(m.user).select(`name ${USER_PLATFORM_FIELDS}`).lean();
  if (!user || user.status !== 'active') throw ApiError.forbidden('This account is deactivated');
  if (await permissionsFor(user)) throw ApiError.forbidden('You cannot log in as a platform team member');
  const society = await Society.findById(m.society).select('name active').lean();
  if (!society?.active) throw new ApiError(403, 'SOCIETY_SUSPENDED', 'This society account is suspended');
  const policy = await effectivePolicy(m.society);
  if (!policy[actor.kind]) throw new ApiError(403, 'LOGIN_AS_DISABLED', '"Log in as" is switched off for {level} in this society', { params: { level: LEVEL_TEXT[actor.kind] } });
  return { membership: m, user, society };
}

async function confirmIdentity(userId, { password, code, backupCode }) {
  const me = await User.findById(userId).select('+passwordHash +mfa');
  if (!me || !(await me.verifyPassword(password))) throw new ApiError(400, 'PASSWORD_INCORRECT', 'Your password is incorrect');
  if (me.mfa?.enabled) {
    if (!code && !backupCode) throw new ApiError(400, 'MFA_CODE_REQUIRED', 'Enter the code from your authenticator app');
    await mfa.confirmSecondFactor(userId, { code, backupCode });
  }
}

const seconds = (a, b) => Math.max(0, Math.round((b - a) / 1000));

// ---------- start / exit ----------
export async function start(ctx, { membershipId, password, code, backupCode, reason, minutes = DEFAULT_MINUTES }) {
  if (ctx.user.actingAs) throw new ApiError(409, 'ALREADY_ACTING', 'Exit the current "Log in as" session first');
  const actor = await actorOf(ctx.user);
  const { membership, user: target, society } = await loadTarget(actor, ctx, membershipId);
  await confirmIdentity(ctx.userId, { password, code, backupCode });

  const now = new Date();
  // One open session per person: an older one left open (closed tab) is closed now.
  const stale = await LoginAsSession.find({ actor: ctx.userId, endedAt: null }).lean();
  if (stale.length) {
    await LoginAsSession.updateMany({ _id: { $in: stale.map((s) => s._id) } }, { $set: { endedAt: now, endedReason: 'replaced' } });
    for (const s of stale) logEnd(s, now, 'replaced', ctx.ip);
  }

  const expiresAt = new Date(now.getTime() + Math.min(minutes, MAX_MINUTES) * 60 * 1000);
  const session = await LoginAsSession.create({
    society: membership.society,
    actor: ctx.userId,
    actorName: ctx.user.name,
    actorLevel: actor.kind,
    target: target._id,
    targetName: target.name,
    targetMembership: membership._id,
    targetRole: membership.role,
    targetUnitLabel: membership.unit?.label,
    reason,
    startedAt: now,
    expiresAt,
    ip: ctx.ip,
  });
  const meta = { sessionId: session._id, target: target._id, targetName: target.name, targetRole: membership.role, unit: membership.unit?.label, by: ctx.userId, byName: ctx.user.name, level: actor.kind, reason, minutes, expiresAt };
  audit.record({ societyId: membership.society, userId: ctx.userId, ip: ctx.ip }, 'login_as.started', 'Membership', membership._id, meta);
  if (actor.kind === 'platform') {
    recordPlatform(ctx, 'login_as.started', { targetType: 'User', targetId: target._id, society: membership.society, details: { ...meta, society: society.name } });
  }

  const accessToken = jwt.sign({ sub: String(target._id), mid: String(membership._id), act: String(session._id) }, env.JWT_ACCESS_SECRET, { expiresIn: seconds(now, expiresAt) });
  const actingAs = actingInfo(session);
  return { accessToken, expiresAt, actingAs, user: actingProfile({ actingAs }, await profile(target._id, membership._id)) };
}

function logEnd(s, at, reason, ip) {
  const durationSeconds = seconds(s.startedAt, at);
  const meta = { sessionId: s._id, target: s.target, targetName: s.targetName, by: s.actor, byName: s.actorName, level: s.actorLevel, reason: s.reason, endedReason: reason, durationSeconds, requests: s.requests };
  audit.record({ societyId: s.society, userId: s.actor, ip }, 'login_as.ended', 'Membership', s.targetMembership, meta);
  if (s.actorLevel === 'platform') recordPlatform({ userId: s.actor, ip }, 'login_as.ended', { targetType: 'User', targetId: s.target, society: s.society, details: meta });
}

// Exit works with the acting token even after it has expired, so the end is always recorded.
export async function exit(bearerToken, ip) {
  let payload;
  try {
    payload = jwt.verify(bearerToken || '', env.JWT_ACCESS_SECRET, { ignoreExpiration: true });
  } catch {
    throw ApiError.unauthorized();
  }
  if (!payload.act || !mongoose.isValidObjectId(payload.act)) throw ApiError.badRequest('You are not logged in as someone else');
  const s = await LoginAsSession.findOne({ _id: payload.act, target: payload.sub }).lean();
  if (!s) throw ApiError.notFound('Session not found');
  if (s.endedAt) return { ended: true, endedAt: s.endedAt, endedReason: s.endedReason };
  const now = new Date();
  const at = s.expiresAt < now ? s.expiresAt : now;
  const reason = s.expiresAt < now ? 'expired' : 'exit';
  const res = await LoginAsSession.updateOne({ _id: s._id, endedAt: null }, { $set: { endedAt: at, endedReason: reason } });
  if (res.modifiedCount) logEnd(s, at, reason, ip);
  return { ended: true, endedAt: at, endedReason: reason };
}

// Job: sessions nobody exited are closed (and logged) once they run out.
export async function closeExpired(now = new Date()) {
  const due = await LoginAsSession.find({ endedAt: null, expiresAt: { $lte: now } }).limit(500).lean();
  for (const s of due) {
    // eslint-disable-next-line no-await-in-loop
    const res = await LoginAsSession.updateOne({ _id: s._id, endedAt: null }, { $set: { endedAt: s.expiresAt, endedReason: 'expired' } });
    if (res.modifiedCount) logEnd(s, s.expiresAt, 'expired', undefined);
  }
  return { closed: due.length };
}

// ---------- history ----------
const status = (s, now = new Date()) => (s.endedAt ? s.endedReason : s.expiresAt <= now ? 'expired' : 'active');
const row = (s) => ({
  _id: s._id,
  society: s.society,
  byName: s.actorName,
  byLevel: s.actorLevel,
  targetName: s.targetName,
  targetRole: s.targetRole,
  targetUnitLabel: s.targetUnitLabel,
  reason: s.reason,
  startedAt: s.startedAt,
  expiresAt: s.expiresAt,
  endedAt: s.endedAt || null,
  status: status(s),
  durationSeconds: seconds(s.startedAt, s.endedAt || Math.min(Date.now(), s.expiresAt.getTime())),
  requests: s.requests,
});

async function pageOf(filter, { page, limit, skip }) {
  const [items, total] = await Promise.all([LoginAsSession.find(filter).sort({ startedAt: -1 }).skip(skip).limit(limit).populate('society', 'name').lean(), LoginAsSession.countDocuments(filter)]);
  return { items: items.map(row), meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

// The person who was viewed: who opened their account, when, why and for how long.
export async function myActivity(ctx) {
  const items = await LoginAsSession.find({ target: ctx.userId }).sort({ startedAt: -1 }).limit(30).populate('society', 'name').lean();
  return items.map(row);
}

export const societySessions = (ctx, pagination) => pageOf({ society: ctx.societyId }, pagination);
export const platformSessions = (filters, pagination) => pageOf(filters.society ? { society: filters.society } : {}, pagination);

// Platform console: a society's members, with whether the platform may log in as each.
export async function societyMembers(societyId, { search }, { page, limit, skip }) {
  await assertSociety(societyId);
  const filter = { society: societyId, status: 'active', support: { $ne: true } };
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    filter.user = { $in: await User.distinct('_id', { $or: [{ name: re }, { email: re }, { phone: re }] }) };
  }
  const [items, total, policy] = await Promise.all([
    Membership.find(filter).sort({ role: 1, createdAt: 1 }).skip(skip).limit(limit).populate('unit', 'label').populate('user', `name email phone ${USER_PLATFORM_FIELDS}`).lean(),
    Membership.countDocuments(filter),
    effectivePolicy(societyId),
  ]);
  const rows = await Promise.all(
    items.map(async (m) => ({
      _id: m._id,
      user: m.user?._id,
      name: m.user?.name,
      email: m.user?.email,
      phone: m.user?.phone,
      role: m.role,
      residentType: m.residentType,
      designation: m.designation,
      unit: m.unit,
      canLoginAs: Boolean(policy.platform && m.user?.status === 'active' && !(await permissionsFor(m.user))),
    })),
  );
  return { items: rows, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}
