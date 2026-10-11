import Unit from '../../modules/units/unit.model.js';
import Membership from '../../modules/users/membership.model.js';
import { ROLES } from '../constants/index.js';

// Shared targeting for notices and polls: { type: 'all' | 'blocks' | 'roles', blocks, roles }.

export async function viewerBlock(ctx) {
  if (!ctx.unitId) return null;
  const unit = await Unit.findById(ctx.unitId).select('block').lean();
  return unit?.block || null;
}

// Mongo filter matching documents whose audience includes the viewer. Admins see everything.
export async function audienceFilter(ctx) {
  if (ctx.role === ROLES.ADMIN) return {};
  const block = await viewerBlock(ctx);
  const or = [{ 'audience.type': 'all' }, { 'audience.type': 'roles', 'audience.roles': ctx.role }];
  if (block) or.push({ 'audience.type': 'blocks', 'audience.blocks': block });
  return { $or: or };
}

// Active user ids that an audience targets (for notifications).
export async function audienceUserIds(societyId, audience) {
  const filter = { society: societyId, status: 'active' };
  if (audience.type === 'roles') filter.role = { $in: audience.roles };
  if (audience.type === 'blocks') {
    const units = await Unit.find({ society: societyId, block: { $in: audience.blocks } }).select('_id').lean();
    filter.unit = { $in: units.map((u) => u._id) };
  }
  const members = await Membership.find(filter).select('user').lean();
  return [...new Set(members.map((m) => String(m.user)))];
}
