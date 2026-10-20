import ApiError from '../../common/errors/ApiError.js';
import LoginAsSession from './loginAsSession.model.js';

// Account-level actions a "Log in as" session must never take for the person being viewed: switching to
// their other homes, changing their password / two-step / sessions / profile, privacy requests, support access.
const BLOCKED = [
  /^\/api\/v1\/auth\/(switch|support-session|change-password|homes|sessions|mfa)(\/|$)/,
  /^\/api\/v1\/me(\/|$)/,
];
const isBlocked = (req) => {
  const path = req.originalUrl.split('?')[0];
  if (path === '/api/v1/auth/me' && req.method !== 'GET') return true;
  return BLOCKED.some((re) => re.test(path));
};

const ended = () => new ApiError(401, 'ACTING_ENDED', 'The "Log in as" session has ended');

export const actingInfo = (s) => ({
  sessionId: s._id,
  by: s.actor,
  byName: s.actorName,
  byLevel: s.actorLevel,
  startedAt: s.startedAt,
  expiresAt: s.expiresAt,
  reason: s.reason,
});

// Called by authenticate() for tokens carrying an `act` claim: the session must still be open and belong to
// this exact (user, membership). Returns the actingAs block that goes on req.user.
export async function resolveActing(payload, req) {
  const s = await LoginAsSession.findById(payload.act).lean();
  if (!s || s.endedAt || s.expiresAt <= new Date()) throw ended();
  if (String(s.target) !== String(payload.sub) || String(s.targetMembership) !== String(payload.mid)) throw ended();
  if (isBlocked(req)) throw new ApiError(403, 'NOT_WHILE_ACTING', 'This is not available while you are logged in as someone else');
  LoginAsSession.updateOne({ _id: s._id }, { $inc: { requests: 1 }, $set: { lastSeenAt: new Date() } }).catch(() => {});
  return actingInfo(s);
}

// /auth/me while acting: only the membership being viewed (not the person's other homes or societies).
export function actingProfile(principal, profile) {
  if (!principal?.actingAs) return profile;
  return {
    ...profile,
    platformPermissions: null,
    mfaSetupRequired: false,
    memberships: (profile.memberships || []).filter((m) => String(m._id) === String(profile.membershipId)),
    actingAs: principal.actingAs,
  };
}
