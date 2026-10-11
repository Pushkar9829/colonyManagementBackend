import ApiError from '../../common/errors/ApiError.js';
import { sha256 } from '../../common/utils/codes.js';
import RefreshToken from './refreshToken.model.js';
import Membership from '../users/membership.model.js';
import User from '../users/user.model.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';
import { ROLES } from '../../common/constants/index.js';

// A "session" is one refresh-token family (one device / browser login).
export async function list(ctx, currentRefreshToken) {
  const now = new Date();
  const current = currentRefreshToken ? await RefreshToken.findOne({ tokenHash: sha256(currentRefreshToken) }).select('family').lean() : null;
  const rows = await RefreshToken.aggregate([
    { $match: { user: ctx.userId, expiresAt: { $gt: now } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$family',
        lastUsedAt: { $first: '$createdAt' },
        startedAt: { $last: '$createdAt' },
        userAgent: { $first: '$userAgent' },
        ip: { $first: '$ip' },
        live: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$revokedAt', null] }, null] }, 1, 0] } }, // missing field ≠ null in $eq
      },
    },
    { $match: { live: { $gt: 0 } } },
    { $sort: { lastUsedAt: -1 } },
  ]);
  return rows.map((r) => ({
    id: r._id,
    current: r._id === current?.family,
    device: describeAgent(r.userAgent),
    userAgent: r.userAgent,
    ip: r.ip,
    startedAt: r.startedAt,
    lastUsedAt: r.lastUsedAt,
  }));
}

function describeAgent(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ') || 'Unknown device';
}

const kill = (filter) => RefreshToken.updateMany(filter, { revokedAt: new Date(), expiresAt: new Date() });

export async function revoke(ctx, family) {
  const res = await kill({ user: ctx.userId, family });
  if (!res.matchedCount) throw ApiError.notFound('Session not found');
}

export async function revokeOthers(ctx, currentRefreshToken) {
  const current = await RefreshToken.findOne({ tokenHash: sha256(currentRefreshToken || ''), user: ctx.userId }).select('family').lean();
  await kill({ user: ctx.userId, ...(current ? { family: { $ne: current.family } } : {}) });
}

// ---- platform support access ----
const SUPPORT_MINUTES = 60;

// Gives the platform owner a temporary admin membership in a society (for support), fully audited and visible
// to the society's admins. It expires on its own after an hour.
export async function startSupportSession(ctx, societyId, reason) {
  const user = await User.findById(ctx.userId).select('platformRole name').lean();
  if (user?.platformRole !== 'super_admin') throw ApiError.forbidden('Platform admins only');
  const expiresAt = new Date(Date.now() + SUPPORT_MINUTES * 60 * 1000);
  // Never turn a real staff role the owner may hold in this society into a temporary one.
  const own = await Membership.findOne({ user: ctx.userId, society: societyId, unit: null, support: { $ne: true } }).lean();
  if (own) throw ApiError.conflict('You are already a member of this society — switch to it from the society menu');
  const membership = await Membership.findOneAndUpdate(
    { user: ctx.userId, society: societyId, unit: null, support: true },
    { $set: { role: ROLES.ADMIN, status: 'active', designation: 'Platform support', support: true, expiresAt } },
    { upsert: true, returnDocument: 'after' },
  );
  const sctx = { societyId, userId: ctx.userId, ip: ctx.ip };
  audit.record(sctx, 'platform.support_session_started', 'Membership', membership._id, { reason, expiresAt });
  await notifyRoles(societyId, [ROLES.ADMIN], {
    type: 'account',
    title: 'Platform support accessed your society',
    body: `${user.name} opened a support session${reason ? `: ${reason}` : ''}. It ends automatically in ${SUPPORT_MINUTES} minutes.`,
    link: '/audit',
    channels: ['inapp', 'email'],
  });
  return membership;
}
