import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';

// Small membership helpers shared by the community modules (directory, chat, forum, marketplace...).

export const MODERATORS = ['admin', 'facility_manager'];
export const isModerator = (ctx) => MODERATORS.includes(ctx.role);
export const sameId = (a, b) => String(a) === String(b);

// Active memberships of one person in one society (several when they own more than one flat).
export const activeMemberships = (societyId, userId) =>
  Membership.find({ society: societyId, user: userId, status: 'active' }).populate('unit', 'label block').lean();

// Throws 404 unless the user is an active member of the society — this is the tenant boundary for
// anything that addresses another person (chat, mentions...). 404 rather than 403 so ids from other
// societies are indistinguishable from ids that don't exist.
export async function requireMember(societyId, userId, message = 'Member not found in this society') {
  const memberships = await activeMemberships(societyId, userId);
  if (!memberships.length) throw ApiError.notFound(message);
  return memberships;
}

// userId -> { _id, name, roles[], units[] } for display next to posts and messages.
// Only name + flat label: phone / email are never exposed through this helper.
export async function memberSummaries(societyId, userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = await Membership.find({ society: societyId, user: { $in: ids }, status: { $in: ['active', 'inactive'] } })
    .populate('user', 'name')
    .populate('unit', 'label')
    .lean();
  for (const m of rows) {
    if (!m.user) continue;
    const key = String(m.user._id);
    const s = out.get(key) || { _id: m.user._id, name: m.user.name, roles: [], units: [], designation: null };
    if (!s.roles.includes(m.role)) s.roles.push(m.role);
    if (m.unit?.label && !s.units.includes(m.unit.label)) s.units.push(m.unit.label);
    if (m.designation && !s.designation) s.designation = m.designation;
    out.set(key, s);
  }
  return out;
}

// Replaces user ids in `field` of each item with member summaries (unknown users become "Former member").
export async function attachAuthors(societyId, items, field = 'author') {
  const map = await memberSummaries(societyId, items.map((i) => i[field]));
  return items.map((i) => ({ ...i, [field]: map.get(String(i[field])) || (i[field] ? { _id: i[field], name: 'Former member', roles: [], units: [] } : null) }));
}
