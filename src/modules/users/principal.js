import User from './user.model.js';
import Membership from './membership.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';

const MFA_POLICY_ROLES = [ROLES.ADMIN, ROLES.ACCOUNTANT];

// Builds the request principal from a token's (user, membership) pair.
// Shape matches what services read via ctx(): { _id, society, role, unit, ... }.
export async function loadPrincipal(userId, membershipId) {
  const { mfa, ...user } = (await User.findById(userId).select('+mfa').lean()) || {};
  if (!user._id || user.status !== 'active') throw ApiError.unauthorized('Account is not active');

  if (!membershipId) {
    // Platform session (no society) — only for the SaaS owner.
    if (user.platformRole !== 'super_admin') throw ApiError.unauthorized('Choose a society to continue');
    return { ...user, role: ROLES.SUPER_ADMIN, society: null, unit: null, membershipId: null };
  }

  const m = await Membership.findOne({ _id: membershipId, user: user._id }).lean();
  if (!m || m.status !== 'active') throw ApiError.unauthorized('This membership is not active');
  if (m.expiresAt && m.expiresAt < new Date()) throw ApiError.unauthorized('This support session has ended');
  const society = await Society.findById(m.society).select('active settings.security').lean();
  if (!society?.active) throw new ApiError(403, 'SOCIETY_SUSPENDED', 'This society account is suspended. Contact support.');

  return {
    ...user,
    society: m.society,
    role: m.role,
    unit: m.unit || null,
    residentType: m.residentType,
    designation: m.designation,
    membershipId: m._id,
    // Society policy: admins and accountants must turn on two-step verification before using the app
    // (support sessions are exempt). authenticate() then allows only the /auth endpoints.
    mfaSetupRequired: Boolean(society.settings?.security?.requireMfa) && MFA_POLICY_ROLES.includes(m.role) && !m.support && !mfa?.enabled,
  };
}

// Picks the membership to open after login: last used if still active, else the first active one.
export async function defaultMembership(user) {
  const active = await Membership.find({ user: user._id, status: 'active', support: { $ne: true } }).sort({ createdAt: 1 }).lean();
  const last = active.find((m) => String(m._id) === String(user.lastMembership));
  return last || active[0] || null;
}
