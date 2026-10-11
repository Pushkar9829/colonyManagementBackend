import User from '../users/user.model.js';
import Membership from '../users/membership.model.js';
import { sendEmailQuietly } from '../../integrations/email.js';
import { ROLES } from '../../common/constants/index.js';
import env from '../../config/env.js';

// Platform users have no society, so the in-app notification store (which is per society) cannot reach
// them. They hear about society-side events by email and see them in the platform console.
export async function platformAdminEmails() {
  const users = await User.find({ platformRole: 'super_admin', status: 'active', email: { $type: 'string' } }).select('email').lean();
  return users.map((u) => u.email);
}

export async function emailPlatformTeam({ subject, text, attachments }) {
  const to = await platformAdminEmails();
  if (to.length) sendEmailQuietly({ to, subject, text, attachments });
  return to.length;
}

export async function societyAdminEmails(societyId, extra = []) {
  const ids = (await Membership.find({ society: societyId, role: ROLES.ADMIN, status: 'active' }).select('user').lean()).map((m) => m.user);
  const users = await User.find({ _id: { $in: ids }, status: 'active', email: { $type: 'string' } }).select('email').lean();
  return [...new Set([...users.map((u) => u.email), ...extra.filter(Boolean)])];
}

export const appLink = (path) => `${env.APP_URL.replace(/\/$/, '')}${path}`;
