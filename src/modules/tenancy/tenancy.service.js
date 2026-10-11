import Lease from './lease.model.js';
import Membership from '../users/membership.model.js';
import Unit from '../units/unit.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { localDateString } from '../../common/utils/dates.js';
import { ROLES } from '../../common/constants/index.js';
import * as uploads from '../uploads/uploads.service.js';
import * as users from '../users/users.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';

const isManager = (ctx) => [ROLES.ADMIN, ROLES.FACILITY_MANAGER].includes(ctx.role);
const isOwnerHere = (ctx) => ctx.role === ROLES.RESIDENT && ctx.user?.residentType === 'owner' && ctx.unitId;
const POPULATE = [
  { path: 'unit', select: 'label' },
  { path: 'tenantUser', select: 'name phone email' },
  { path: 'ownerUser', select: 'name phone email' },
  { path: 'policeVerification.verifiedBy', select: 'name' },
  { path: 'endedBy', select: 'name' },
];

export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

function present(lease, today = localDateString()) {
  const l = lease.toObject ? lease.toObject() : lease;
  l.daysLeft = l.status === 'active' ? daysBetween(today, l.endDate) : null;
  l.moveOutDue = l.status === 'active' && l.daysLeft < 0;
  return l;
}

// Managers see every lease; a tenant sees their own; an owner sees the leases of their flat.
function scopeFilter(ctx) {
  const filter = { society: ctx.societyId };
  if (!isManager(ctx)) {
    const or = [{ tenantUser: ctx.userId }, { ownerUser: ctx.userId }];
    if (isOwnerHere(ctx)) or.push({ unit: ctx.unitId });
    filter.$or = or;
  }
  return filter;
}

async function load(ctx, id) {
  const lease = await Lease.findOne({ ...scopeFilter(ctx), _id: id });
  if (!lease) throw ApiError.notFound('Lease not found');
  return lease;
}

const reload = async (id) => present(await Lease.findById(id).populate(POPULATE).lean());

export async function create(ctx, data) {
  const unit = await Unit.findOne({ _id: data.unit, society: ctx.societyId }).select('label').lean();
  if (!unit) throw ApiError.badRequest('Unit not found');
  const tenant = await Membership.findOne({ _id: data.tenantMembership, society: ctx.societyId, unit: unit._id, role: ROLES.RESIDENT }).lean();
  if (!tenant) throw ApiError.badRequest('The tenant must be a resident member of this unit');
  if (tenant.residentType !== 'tenant') throw ApiError.badRequest('This member is not registered as a tenant');

  let owner = null;
  if (data.ownerMembership) {
    owner = await Membership.findOne({ _id: data.ownerMembership, society: ctx.societyId, unit: unit._id, role: ROLES.RESIDENT, residentType: 'owner' }).lean();
    if (!owner) throw ApiError.badRequest('The owner must be an owner member of this unit');
  } else {
    owner = await Membership.findOne({ society: ctx.societyId, unit: unit._id, role: ROLES.RESIDENT, residentType: 'owner', status: 'active' }).lean();
  }
  if (await Lease.exists({ society: ctx.societyId, unit: unit._id, status: 'active' })) {
    throw ApiError.conflict(`${unit.label} already has an active lease. End it before adding a new one.`);
  }

  const agreement = await uploads.resolve(ctx, data.agreement);
  let lease;
  try {
    lease = await Lease.create({
      ...data,
      agreement,
      society: ctx.societyId,
      tenantUser: tenant.user,
      ownerMembership: owner?._id,
      ownerUser: owner?.user,
      createdBy: ctx.userId,
    });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict(`${unit.label} already has an active lease`);
    throw err;
  }
  audit.record(ctx, 'lease.created', 'Lease', lease._id, { unit: unit.label, startDate: data.startDate, endDate: data.endDate });
  await notifyUsers(ctx.societyId, [tenant.user, owner?.user], {
    type: 'lease',
    title: `Lease recorded for ${unit.label}`,
    body: `${data.startDate} to ${data.endDate}`,
    link: '/household?tab=lease',
  });
  return reload(lease._id);
}

export async function list(ctx, filters, pagination) {
  const filter = scopeFilter(ctx);
  const today = localDateString();
  if (filters.status) filter.status = filters.status;
  if (filters.unit) filter.unit = filters.unit;
  if (filters.expiringWithinDays !== undefined) {
    filter.status = 'active';
    filter.endDate = { $gte: today, $lte: localDateString(Date.now() + filters.expiringWithinDays * 86400000) };
  }
  if (filters.expired) {
    filter.status = 'active';
    filter.endDate = { $lt: today };
  }
  const result = await paginate(Lease, filter, pagination, { sort: { status: 1, endDate: 1 }, populate: POPULATE });
  result.items = result.items.map((l) => present(l, today));
  return result;
}

export async function getById(ctx, id) {
  await load(ctx, id);
  return reload(id);
}

export async function update(ctx, id, data) {
  const lease = await load(ctx, id);
  if (lease.status !== 'active') throw ApiError.conflict('Ended leases cannot be edited');
  const { policeVerification, ...rest } = data;
  const start = rest.startDate ?? lease.startDate;
  const end = rest.endDate ?? lease.endDate;
  if (end <= start) throw ApiError.badRequest('End date must be after the start date');
  // An extended lease gets fresh expiry reminders.
  if (rest.endDate && rest.endDate > lease.endDate) lease.remindersSent = [];
  Object.assign(lease, rest);
  if (policeVerification) {
    const pv = lease.policeVerification;
    if (policeVerification.reference !== undefined) pv.reference = policeVerification.reference;
    if (policeVerification.notes !== undefined) pv.notes = policeVerification.notes;
    if (policeVerification.status && policeVerification.status !== pv.status) {
      pv.status = policeVerification.status;
      pv.verifiedAt = policeVerification.status === 'verified' ? new Date() : undefined;
      pv.verifiedBy = policeVerification.status === 'verified' ? ctx.userId : undefined;
      await notifyUsers(ctx.societyId, [lease.tenantUser, lease.ownerUser], {
        type: 'lease',
        title: `Police verification ${policeVerification.status.replace('_', ' ')}`,
        body: policeVerification.notes || 'Tenant police verification status changed',
        link: '/household?tab=lease',
      });
    }
  }
  await lease.save();
  audit.record(ctx, 'lease.updated', 'Lease', lease._id, data);
  return reload(lease._id);
}

// Tenant, owner or a manager attaches the agreement or police verification papers.
export async function addDocuments(ctx, id, { kind, files, reference }) {
  const lease = await load(ctx, id);
  const attachments = await uploads.resolve(ctx, files);
  if (kind === 'agreement') lease.agreement.push(...attachments);
  else {
    lease.policeVerification.documents.push(...attachments);
    if (reference) lease.policeVerification.reference = reference;
    if (['not_submitted', 'rejected'].includes(lease.policeVerification.status)) lease.policeVerification.status = 'submitted';
  }
  await lease.save();
  if (!isManager(ctx)) {
    await notifyRoles(ctx.societyId, [ROLES.ADMIN, ROLES.FACILITY_MANAGER], {
      type: 'lease',
      title: kind === 'police' ? 'Police verification submitted' : 'Rental agreement uploaded',
      body: 'Review the documents in Tenancies',
      link: '/tenancies',
    });
  }
  return reload(lease._id);
}

// Ends the lease; with moveOut the tenant's membership is deactivated too (admins only, as in Members).
export async function end(ctx, id, { reason, moveOut }) {
  const lease = await load(ctx, id);
  if (lease.status !== 'active') throw ApiError.conflict('Lease already ended');
  if (moveOut && ctx.role !== ROLES.ADMIN) throw ApiError.forbidden('Only admins can deactivate the tenant on move-out');
  if (moveOut) {
    const m = await Membership.findOne({ _id: lease.tenantMembership, society: ctx.societyId }).select('status').lean();
    if (m && m.status === 'active') await users.update(ctx, lease.tenantMembership, { status: 'inactive' });
  }
  lease.status = 'ended';
  lease.endedAt = new Date();
  lease.endReason = reason;
  lease.movedOut = Boolean(moveOut);
  lease.endedBy = ctx.userId;
  await lease.save();
  audit.record(ctx, 'lease.ended', 'Lease', lease._id, { reason, moveOut });
  await notifyUsers(ctx.societyId, [lease.tenantUser, lease.ownerUser], {
    type: 'lease',
    title: moveOut ? 'Tenant moved out' : 'Lease ended',
    body: reason,
    link: '/household?tab=lease',
  });
  return reload(lease._id);
}

// Past and current tenants of a unit (managers, or the owner of that unit).
export async function history(ctx, unitId) {
  if (!isManager(ctx) && !(isOwnerHere(ctx) && String(ctx.unitId) === String(unitId))) throw ApiError.forbidden();
  const unit = await Unit.findOne({ _id: unitId, society: ctx.societyId }).select('label occupancy').lean();
  if (!unit) throw ApiError.notFound('Unit not found');
  const leases = await Lease.find({ society: ctx.societyId, unit: unitId }).sort({ startDate: -1 }).populate(POPULATE).lean();
  return { unit, leases: leases.map((l) => present(l)) };
}

// ---------- scheduled ----------
// 30 and 7 days before the end date the owner, tenant and admins are reminded; once the date
// passes they get a single "confirm move-out" prompt.
export async function expiryReminders(now = new Date()) {
  const today = localDateString(now);
  const horizon = localDateString(now.getTime() + 30 * 86400000);
  const leases = await Lease.find({ status: 'active', endDate: { $lte: horizon }, remindersSent: { $ne: 'expired' } })
    .populate('unit', 'label')
    .limit(2000);
  const sent = { '30': 0, '7': 0, expired: 0 };
  for (const lease of leases) {
    const days = daysBetween(today, lease.endDate);
    let key = null;
    if (days < 0) key = 'expired';
    else if (days <= 7) key = '7';
    else if (days <= 30) key = '30';
    if (!key || lease.remindersSent.includes(key)) continue;
    const label = lease.unit?.label || 'a unit';
    const payload = key === 'expired'
      ? { title: `Lease for ${label} has ended`, body: `It ended on ${lease.endDate}. Confirm the tenant's move-out or extend the lease.` }
      : { title: `Lease for ${label} ends in ${days} day${days === 1 ? '' : 's'}`, body: `End date ${lease.endDate}. Renew or plan the move-out.` };
    const msg = { type: 'lease', ...payload, link: '/tenancies', channels: ['inapp', 'push', 'email'] };
    /* eslint-disable no-await-in-loop */
    await notifyUsers(lease.society, [lease.ownerUser, lease.tenantUser], { ...msg, link: '/household?tab=lease' });
    await notifyRoles(lease.society, [ROLES.ADMIN], msg);
    /* eslint-enable no-await-in-loop */
    // a 7-day reminder also covers the 30-day one, so a late-created lease never gets both
    lease.remindersSent = [...new Set([...lease.remindersSent, key, ...(key === '7' || key === 'expired' ? ['30'] : []), ...(key === 'expired' ? ['7'] : [])])];
    await lease.save(); // eslint-disable-line no-await-in-loop
    sent[key] += 1;
  }
  return sent;
}
