import Society from '../society/society.model.js';
import Unit from '../units/unit.model.js';
import User from '../users/user.model.js';
import Membership from '../users/membership.model.js';
import Payment from '../payments/payment.model.js';
import Bill from '../billing/bill.model.js';
import AuditLog from '../audit/audit.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { PLANS, ROLES } from '../../common/constants/index.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { addDays } from '../../common/utils/dates.js';
import { jobStatus } from '../../jobs/scheduler.js';
import logger from '../../common/utils/logger.js';
import { clearCache as clearFeatureCache } from '../features/features.service.js';

// Platform-wide numbers for the SaaS owner. Reads across every tenant on purpose.
export async function stats() {
  const since = addDays(new Date(), -30);
  const [societies, activeSocieties, newSocieties, units, members, users, activeUsers, collected, outstanding] = await Promise.all([
    Society.countDocuments(),
    Society.countDocuments({ active: true }),
    Society.countDocuments({ createdAt: { $gte: since } }),
    Unit.countDocuments(),
    Membership.countDocuments({ status: 'active' }),
    User.countDocuments(),
    User.countDocuments({ lastLoginAt: { $gte: since } }),
    Payment.aggregate([{ $match: { status: 'success', paidAt: { $gte: since } } }, { $group: { _id: null, sum: { $sum: '$amount' } } }]),
    Bill.aggregate([{ $match: { status: { $in: ['unpaid', 'partial'] } } }, { $group: { _id: null, sum: { $sum: { $subtract: ['$total', '$paid'] } } } }]),
  ]);
  const plans = await Society.aggregate([{ $group: { _id: '$plan.name', count: { $sum: 1 } } }]);
  return {
    societies,
    activeSocieties,
    newSocieties30d: newSocieties,
    units,
    activeMembers: members,
    users,
    activeUsers30d: activeUsers,
    collected30d: collected[0]?.sum || 0,
    outstanding: outstanding[0]?.sum || 0,
    plans: Object.fromEntries(plans.map((p) => [p._id || 'free', p.count])),
  };
}

export async function listSocieties(filters, { page, limit, skip }) {
  const match = {};
  if (filters.search) {
    const rx = { $regex: escapeRegex(filters.search), $options: 'i' };
    match.$or = [{ name: rx }, { city: rx }, { code: rx }];
  }
  if (filters.status) match.active = filters.status === 'active';
  if (filters.plan) match['plan.name'] = filters.plan;

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [items, total] = await Promise.all([
    Society.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      { $lookup: { from: 'units', localField: '_id', foreignField: 'society', as: 'u', pipeline: [{ $count: 'n' }] } },
      { $lookup: { from: 'memberships', localField: '_id', foreignField: 'society', as: 'm', pipeline: [{ $match: { status: 'active' } }, { $count: 'n' }] } },
      {
        $lookup: {
          from: 'payments',
          localField: '_id',
          foreignField: 'society',
          as: 'p',
          pipeline: [{ $match: { status: 'success', paidAt: { $gte: monthStart } } }, { $group: { _id: null, sum: { $sum: '$amount' } } }],
        },
      },
      { $lookup: { from: 'auditlogs', localField: '_id', foreignField: 'society', as: 'a', pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 1 }, { $project: { createdAt: 1 } }] } },
      {
        $project: {
          name: 1,
          code: 1,
          city: 1,
          state: 1,
          active: 1,
          plan: 1,
          suspendedReason: 1,
          createdAt: 1,
          units: { $ifNull: [{ $first: '$u.n' }, 0] },
          members: { $ifNull: [{ $first: '$m.n' }, 0] },
          collectedThisMonth: { $ifNull: [{ $first: '$p.sum' }, 0] },
          lastActivityAt: { $first: '$a.createdAt' },
        },
      },
    ]),
    Society.countDocuments(match),
  ]);
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getSociety(id) {
  const society = await Society.findById(id).lean();
  if (!society) throw ApiError.notFound('Society not found');
  const [admins, units, members, recent] = await Promise.all([
    Membership.find({ society: id, role: ROLES.ADMIN, status: 'active' }).populate('user', 'name email phone lastLoginAt').lean(),
    Unit.countDocuments({ society: id }),
    Membership.aggregate([{ $match: { society: society._id, status: 'active' } }, { $group: { _id: '$role', count: { $sum: 1 } } }]),
    AuditLog.find({ society: id }).sort({ createdAt: -1 }).limit(10).populate('actor', 'name').lean(),
  ]);
  return {
    ...society,
    units,
    membersByRole: Object.fromEntries(members.map((m) => [m._id, m.count])),
    admins: admins.map((a) => ({ _id: a._id, designation: a.designation, ...a.user })),
    recentActivity: recent,
  };
}

function societyChanges(data) {
  const set = {};
  if (data.active !== undefined) {
    set.active = data.active;
    set.suspendedReason = data.active ? undefined : data.suspendedReason || 'Suspended by platform';
  }
  if (data.plan) {
    set['plan.name'] = data.plan.name;
    set['plan.unitLimit'] = data.plan.unitLimit === undefined ? PLANS[data.plan.name].unitLimit : data.plan.unitLimit;
    if (data.plan.validUntil !== undefined) set['plan.validUntil'] = data.plan.validUntil;
  }
  // Paid-until alone (subscription payments) without touching the plan name / unit limit.
  if (data.validUntil !== undefined) set['plan.validUntil'] = data.validUntil;
  if (data.platformNotes !== undefined) set.platformNotes = data.platformNotes;
  return set;
}

async function applySocietyChanges(id, data, actorId, action) {
  const set = societyChanges(data);
  // Mongoose drops undefined values from $set, so a reactivation must $unset the old reason explicitly.
  const update = set.suspendedReason === undefined && 'suspendedReason' in set ? { $set: (({ suspendedReason, ...rest }) => rest)(set), $unset: { suspendedReason: 1 } } : { $set: set };
  const society = await Society.findByIdAndUpdate(id, update, { returnDocument: 'after', runValidators: true }).lean();
  if (!society) throw ApiError.notFound('Society not found');
  if (data.plan) clearFeatureCache(id); // plan defaults decide which modules are on
  // Platform actions are logged against the society so its admins can see them too.
  AuditLog.create({ society: id, actor: actorId, action, entity: 'Society', entityId: id, meta: data }).catch((err) => logger.error({ err }, 'audit write failed'));
  return society;
}

export const updateSociety = (platformUser, id, data) => applySocietyChanges(id, data, platformUser._id, 'platform.society_updated');

// Changes made by the platform itself (subscription payments, dunning job): no human actor.
// data: { active?, suspendedReason?, validUntil?, plan? } — same shape as updateSociety.
export const systemUpdateSociety = (id, data, action = 'platform.society_updated_by_system') => applySocietyChanges(id, data, null, action);

export const jobs = () => jobStatus();
