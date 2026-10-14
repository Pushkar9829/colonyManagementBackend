import User from '../users/user.model.js';
import Membership from '../users/membership.model.js';
import { sendEmailQuietly } from '../../integrations/email.js';
import { ROLES } from '../../common/constants/index.js';
import env from '../../config/env.js';
import { activeOwnersFilter, membersWithPermission } from '../platformTeam/access.js';

// Platform users have no society, so the in-app notification store (which is per society) cannot reach
// them. They hear about society-side events by email and see them in the platform console.
// Owners always; with `permission`, also the active platform members whose role holds it.
export async function platformAdminEmails(permission) {
  const users = permission
    ? await membersWithPermission(permission, 'email')
    : await User.find({ ...activeOwnersFilter(), email: { $type: 'string' } }).select('email').lean();
  return [...new Set(users.map((u) => u.email).filter(Boolean))];
}

export async function emailPlatformTeam({ subject, text, attachments, permission }) {
  const to = await platformAdminEmails(permission);
  if (to.length) sendEmailQuietly({ to, subject, text, attachments });
  return to.length;
}

export async function societyAdminEmails(societyId, extra = []) {
  const ids = (await Membership.find({ society: societyId, role: ROLES.ADMIN, status: 'active' }).select('user').lean()).map((m) => m.user);
  const users = await User.find({ _id: { $in: ids }, status: 'active', email: { $type: 'string' } }).select('email').lean();
  return [...new Set([...users.map((u) => u.email), ...extra.filter(Boolean)])];
}

export const appLink = (path) => `${env.APP_URL.replace(/\/$/, '')}${path}`;
