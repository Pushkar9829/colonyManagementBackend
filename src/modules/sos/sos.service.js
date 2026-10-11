import SosAlert from './sos.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { ROLES } from '../../common/constants/index.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';
import { invalidate } from '../../realtime/socket.js';

const refreshSos = (ctx) => invalidate(ctx.societyId, ['sos', 'dashboard'], { roles: RESPONDERS });

const RESPONDERS = [ROLES.ADMIN, ROLES.GUARD, ROLES.FACILITY_MANAGER];
const POPULATE = [
  { path: 'raisedBy', select: 'name phone' },
  { path: 'unit', select: 'label' },
  { path: 'acknowledgedBy', select: 'name' },
  { path: 'resolvedBy', select: 'name' },
];

export async function raise(ctx, data) {
  const alert = await SosAlert.create({ ...data, society: ctx.societyId, raisedBy: ctx.userId, unit: ctx.unitId || undefined });
  const populated = await SosAlert.findById(alert._id).populate(POPULATE).lean();
  await notifyRoles(ctx.societyId, RESPONDERS, {
    type: 'sos',
    title: `SOS: ${data.type.toUpperCase()}`,
    body: `${populated.raisedBy.name}${populated.unit ? ` (${populated.unit.label})` : ''}${data.location ? ` at ${data.location}` : ''}${data.message ? ` — ${data.message}` : ''}`,
    link: '/sos',
    channels: ['inapp', 'push', 'sms', 'whatsapp'],
    urgent: true,
  });
  refreshSos(ctx);
  audit.record(ctx, 'sos.raised', 'SosAlert', alert._id, { type: data.type });
  return populated;
}

export function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (ctx.role === ROLES.RESIDENT) filter.raisedBy = ctx.userId;
  if (filters.status) filter.status = filters.status;
  return paginate(SosAlert, filter, pagination, { populate: POPULATE });
}

export async function acknowledge(ctx, id) {
  const alert = await SosAlert.findOneAndUpdate(
    { _id: id, society: ctx.societyId, status: 'active' },
    { status: 'acknowledged', acknowledgedBy: ctx.userId, acknowledgedAt: new Date() },
    { returnDocument: 'after' },
  ).populate(POPULATE);
  if (!alert) throw ApiError.conflict('Alert is not active');
  await notifyUsers(ctx.societyId, [alert.raisedBy._id], { type: 'sos', title: 'Help is on the way', body: `${alert.acknowledgedBy.name} acknowledged your SOS`, link: '/sos' });
  refreshSos(ctx);
  return alert.toObject();
}

export async function resolve(ctx, id, resolutionNote) {
  const filter = { _id: id, society: ctx.societyId, status: { $ne: 'resolved' } };
  // Residents may close their own alert (e.g. raised by mistake).
  if (ctx.role === ROLES.RESIDENT) filter.raisedBy = ctx.userId;
  const alert = await SosAlert.findOneAndUpdate(
    filter,
    { status: 'resolved', resolvedBy: ctx.userId, resolvedAt: new Date(), resolutionNote },
    { returnDocument: 'after' },
  ).populate(POPULATE);
  if (!alert) throw ApiError.conflict('Alert not found or already resolved');
  audit.record(ctx, 'sos.resolved', 'SosAlert', alert._id);
  refreshSos(ctx);
  return alert.toObject();
}
