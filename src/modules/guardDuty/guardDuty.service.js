import { Handover, Incident, OccurrenceEntry } from './guardDuty.model.js';
import Visitor from '../visitors/visitor.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { localDateString } from '../../common/utils/dates.js';
import { ROLES } from '../../common/constants/index.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import * as vehicles from '../vehicles/vehicles.service.js';
import { nextNumber } from '../counter/counter.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import { eventTime } from '../visitors/gateTime.js';

const refresh = (societyId) => invalidate(societyId, ['guardDuty'], { roles: [ROLES.GUARD] });

async function logOccurrence(ctx, { at = new Date(), category, text, refModel, ref }) {
  await OccurrenceEntry.create({ society: ctx.societyId, date: localDateString(at), at, category, text: text.slice(0, 500), by: ctx.userId, refModel, ref });
}

// ---------- handovers ----------
const HANDOVER_POPULATE = [
  { path: 'fromGuard', select: 'name' },
  { path: 'toGuard', select: 'name' },
  { path: 'acknowledgedBy', select: 'name' },
];

export async function createHandover(ctx, data) {
  const doc = await Handover.create({ ...data, society: ctx.societyId, fromGuard: ctx.userId });
  const pending = (data.pendingItems || []).filter((p) => !p.done).length;
  await logOccurrence(ctx, {
    category: 'handover',
    text: `${data.shift} shift handed over${data.notes ? `: ${data.notes}` : ''}${pending ? ` · ${pending} pending item(s)` : ''}`,
    refModel: 'Handover',
    ref: doc._id,
  });
  if (data.toGuard) {
    await notifyUsers(ctx.societyId, [data.toGuard], { type: 'duty', title: 'Shift handover waiting for you', body: data.notes?.slice(0, 120) || `${data.shift} shift`, link: '/duty' });
  }
  refresh(ctx.societyId);
  return Handover.findById(doc._id).populate(HANDOVER_POPULATE).lean();
}

export function listHandovers(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.status) filter.status = filters.status;
  return paginate(Handover, filter, pagination, { populate: HANDOVER_POPULATE });
}

// The next guard (anyone but the author) confirms they received the keys and notes.
export async function acknowledgeHandover(ctx, id, { note, pendingItems }) {
  const h = await Handover.findOne({ _id: id, society: ctx.societyId });
  if (!h) throw ApiError.notFound('Handover not found');
  if (h.status === 'acknowledged') throw ApiError.conflict('Already acknowledged');
  if (String(h.fromGuard) === String(ctx.userId)) throw ApiError.forbidden('The incoming guard must acknowledge the handover');
  if (h.toGuard && String(h.toGuard) !== String(ctx.userId) && ctx.role === ROLES.GUARD) throw ApiError.forbidden('This handover is addressed to another guard');
  h.status = 'acknowledged';
  h.acknowledgedBy = ctx.userId;
  h.acknowledgedAt = new Date();
  h.ackNote = note;
  if (pendingItems) h.pendingItems = pendingItems;
  if (!h.toGuard) h.toGuard = ctx.userId;
  await h.save();
  await logOccurrence(ctx, { category: 'handover', text: `Handover acknowledged${note ? `: ${note}` : ''}`, refModel: 'Handover', ref: h._id });
  await notifyUsers(ctx.societyId, [h.fromGuard], { type: 'duty', title: 'Your handover was acknowledged', body: note || '', link: '/duty' });
  refresh(ctx.societyId);
  return Handover.findById(h._id).populate(HANDOVER_POPULATE).lean();
}

// ---------- incidents ----------
const INCIDENT_POPULATE = [
  { path: 'reportedBy', select: 'name' },
  { path: 'closedBy', select: 'name' },
  { path: 'unit', select: 'label' },
  { path: 'visitor', select: 'name phone status' },
  { path: 'vehicle', select: 'number make color' },
];

export async function createIncident(ctx, { photos = [], visitorId, occurredAt, ...data }) {
  const files = await uploads.resolve(ctx, photos);
  const at = eventTime(occurredAt) || new Date();
  let unit;
  if (visitorId) {
    const v = await Visitor.findOne({ _id: visitorId, society: ctx.societyId }).select('unit').lean();
    if (!v) throw ApiError.badRequest('Linked visitor not found');
    unit = v.unit;
  }
  const vehicle = data.vehicleNumber ? await vehicles.findByPlate(ctx.societyId, data.vehicleNumber) : null;
  const doc = await Incident.create({
    ...data,
    society: ctx.societyId,
    number: await nextNumber(ctx.societyId, 'incident', 'INC'),
    photos: files,
    occurredAt: at,
    visitor: visitorId,
    vehicle: vehicle?._id,
    unit: unit || vehicle?.unit?._id,
    reportedBy: ctx.userId,
  });
  await logOccurrence(ctx, { at, category: 'incident', text: `${doc.number} ${data.type.replace('_', ' ')}: ${data.title}`, refModel: 'Incident', ref: doc._id });
  const serious = ['high', 'critical'].includes(doc.severity);
  await notifyRoles(ctx.societyId, [ROLES.ADMIN, ROLES.FACILITY_MANAGER], {
    type: 'security',
    title: `Incident ${doc.number}: ${doc.title}`,
    body: `${doc.severity} · ${doc.type.replace('_', ' ')}${doc.location ? ` · ${doc.location}` : ''}`,
    link: '/duty?tab=incidents',
    channels: serious ? ['inapp', 'push', 'sms'] : ['inapp', 'push'],
    urgent: doc.severity === 'critical',
  });
  audit.record(ctx, 'incident.reported', 'SecurityIncident', doc._id, { type: doc.type, severity: doc.severity });
  refresh(ctx.societyId);
  return Incident.findById(doc._id).populate(INCIDENT_POPULATE).lean();
}

export function listIncidents(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.status) filter.status = filters.status;
  if (filters.type) filter.type = filters.type;
  if (filters.from || filters.to) {
    filter.occurredAt = {};
    if (filters.from) filter.occurredAt.$gte = filters.from;
    if (filters.to) filter.occurredAt.$lt = filters.to;
  }
  return paginate(Incident, filter, pagination, { sort: { occurredAt: -1 }, populate: INCIDENT_POPULATE });
}

export async function getIncident(ctx, id) {
  const doc = await Incident.findOne({ _id: id, society: ctx.societyId }).populate(INCIDENT_POPULATE).lean();
  if (!doc) throw ApiError.notFound('Incident not found');
  return doc;
}

export async function closeIncident(ctx, id, { actionTaken }) {
  const doc = await Incident.findOneAndUpdate(
    { _id: id, society: ctx.societyId, status: 'open' },
    { status: 'closed', actionTaken, closedBy: ctx.userId, closedAt: new Date() },
    { returnDocument: 'after' },
  )
    .populate(INCIDENT_POPULATE)
    .lean();
  if (!doc) throw ApiError.conflict('Incident not found or already closed');
  await logOccurrence(ctx, { category: 'incident', text: `${doc.number} closed: ${actionTaken}`, refModel: 'Incident', ref: doc._id });
  audit.record(ctx, 'incident.closed', 'SecurityIncident', id, { actionTaken });
  refresh(ctx.societyId);
  return doc;
}

// ---------- occurrence book ----------
export async function occurrenceBook(ctx, { date }) {
  const day = date || localDateString();
  const items = await OccurrenceEntry.find({ society: ctx.societyId, date: day }).sort({ at: 1 }).populate('by', 'name').lean();
  return { date: day, entries: items };
}

export async function addOccurrence(ctx, { text, category, occurredAt }) {
  const at = eventTime(occurredAt) || new Date();
  await logOccurrence(ctx, { at, category, text });
  refresh(ctx.societyId);
  return occurrenceBook(ctx, { date: localDateString(at) });
}

// Guards of this society, for the handover "to" picker.
export async function guards(ctx) {
  const ms = await Membership.find({ society: ctx.societyId, role: ROLES.GUARD, status: 'active' }).populate('user', 'name').select('user').lean();
  return ms.filter((m) => m.user).map((m) => ({ _id: m.user._id, name: m.user.name })).sort((a, b) => a.name.localeCompare(b.name));
}
