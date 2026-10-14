import { Child, ChildAlert, EmergencyContact } from './emergency.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { ROLES } from '../../common/constants/index.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import * as gateSvc from '../gates/gates.service.js';
import { notifyRoles, notifyUnit, notifyUsers } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;

// ---------- emergency directory ----------
export function listContacts(ctx, { all }) {
  const filter = { society: ctx.societyId };
  const manager = [ROLES.ADMIN, ROLES.FACILITY_MANAGER].includes(ctx.role);
  if (!all || !manager) filter.active = true;
  return EmergencyContact.find(filter).sort({ order: 1, name: 1 }).lean();
}

export async function createContact(ctx, data) {
  const last = await EmergencyContact.findOne({ society: ctx.societyId }).sort({ order: -1 }).select('order').lean();
  const doc = await EmergencyContact.create({ ...data, society: ctx.societyId, order: data.order ?? (last ? last.order + 1 : 0) });
  audit.record(ctx, 'emergency.contact_created', 'EmergencyContact', doc._id, { name: doc.name });
  invalidate(ctx.societyId, ['emergency']);
  return doc.toObject();
}

export async function updateContact(ctx, id, data) {
  const doc = await EmergencyContact.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: data }, { returnDocument: 'after' }).lean();
  if (!doc) throw ApiError.notFound('Contact not found');
  invalidate(ctx.societyId, ['emergency']);
  return doc;
}

export async function removeContact(ctx, id) {
  const res = await EmergencyContact.deleteOne({ _id: id, society: ctx.societyId });
  if (!res.deletedCount) throw ApiError.notFound('Contact not found');
  audit.record(ctx, 'emergency.contact_removed', 'EmergencyContact', id);
  invalidate(ctx.societyId, ['emergency']);
}

// Saves a new display order from the full list of ids (top first).
export async function reorderContacts(ctx, ids) {
  const n = await EmergencyContact.countDocuments({ society: ctx.societyId, _id: { $in: ids } });
  if (n !== new Set(ids).size) throw ApiError.badRequest('One or more contacts are invalid');
  await EmergencyContact.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id, society: ctx.societyId }, update: { order } } })));
  invalidate(ctx.societyId, ['emergency']);
  return listContacts(ctx, { all: true });
}

// ---------- children ----------
export function listChildren(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  else {
    // Guards see only children whose parents asked for exit alerts.
    filter.alertOnExit = true;
    if (filters.unit) filter.unit = filters.unit;
  }
  if (filters.search) filter.name = { $regex: escapeRegex(filters.search), $options: 'i' };
  return paginate(Child, filter, pagination, { sort: { name: 1 }, populate: { path: 'unit', select: 'label' } });
}

export async function createChild(ctx, { photo, ...data }) {
  if (!ctx.unitId) throw ApiError.badRequest('Only residents linked to a unit can register children');
  const [file] = await uploads.resolve(ctx, photo ? [photo] : []);
  const doc = await Child.create({ ...data, photoUrl: file?.url, society: ctx.societyId, unit: ctx.unitId, createdBy: ctx.userId });
  invalidate(ctx.societyId, ['children'], { roles: [ROLES.GUARD], unit: ctx.unitId });
  return Child.findById(doc._id).populate('unit', 'label').lean();
}

export async function updateChild(ctx, id, { photo, removePhoto, ...data }) {
  const doc = await Child.findOne({ _id: id, society: ctx.societyId, unit: ctx.unitId });
  if (!doc) throw ApiError.notFound('Child not found');
  Object.assign(doc, data);
  if (photo) {
    const [file] = await uploads.resolve(ctx, [photo]);
    doc.photoUrl = file.url;
  } else if (removePhoto) doc.photoUrl = undefined;
  await doc.save();
  invalidate(ctx.societyId, ['children'], { roles: [ROLES.GUARD], unit: ctx.unitId });
  return Child.findById(doc._id).populate('unit', 'label').lean();
}

export async function removeChild(ctx, id) {
  const res = await Child.deleteOne({ _id: id, society: ctx.societyId, unit: ctx.unitId });
  if (!res.deletedCount) throw ApiError.notFound('Child not found');
  invalidate(ctx.societyId, ['children'], { roles: [ROLES.GUARD], unit: ctx.unitId });
}

// ---------- child exit alerts ----------
const ALERT_POPULATE = [
  { path: 'child', select: 'name age photoUrl' },
  { path: 'unit', select: 'label' },
  { path: 'raisedBy', select: 'name' },
  { path: 'acknowledgedBy', select: 'name' },
];

// Guard's one-tap "child exiting": urgent push + SMS to the household (SMS ignores opt-outs for safety).
// Any gate may raise one (a child's safety is not limited by gate rules).
export async function raiseChildExit(ctx, childId, { gateId, gate: gateName, note }) {
  const g = await gateSvc.resolveGate(ctx, gateId || gateName, { freeText: true });
  const gate = g.name;
  const child = await Child.findOne({ _id: childId, society: ctx.societyId }).populate('unit', 'label').lean();
  if (!child) throw ApiError.notFound('Child not found');
  if (!child.alertOnExit) throw ApiError.badRequest(`${child.name}'s parents have not asked for exit alerts`);
  const recent = await ChildAlert.findOne({ society: ctx.societyId, child: child._id, status: 'open', createdAt: { $gte: new Date(Date.now() - 2 * 60000) } }).lean();
  if (recent) throw ApiError.conflict('An alert for this child was raised a moment ago and is waiting for the parent');
  const alert = await ChildAlert.create({ society: ctx.societyId, child: child._id, unit: child.unit._id, gate, gateId: g._id, note, raisedBy: ctx.userId });
  await notifyUnit(ctx.societyId, child.unit._id, {
    type: 'child_alert',
    title: `${child.name} is leaving through ${gate || 'the gate'}`,
    body: `${note ? `${note} · ` : ''}Open the app and tell the guard if this is OK`,
    link: '/child-safety',
    channels: ['inapp', 'push', 'sms'],
    urgent: true,
  });
  invalidate(ctx.societyId, ['childAlerts'], { roles: [ROLES.GUARD], unit: child.unit._id });
  audit.record(ctx, 'child.exit_alert', 'ChildExitAlert', alert._id, { child: child.name, unit: child.unit.label });
  return ChildAlert.findById(alert._id).populate(ALERT_POPULATE).lean();
}

export function listAlerts(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  if (filters.status) filter.status = filters.status;
  return paginate(ChildAlert, filter, pagination, { populate: ALERT_POPULATE });
}

// Parent answers: "ok" (child may go) or "stop" (guard should hold the child).
export async function acknowledgeAlert(ctx, id, { response, note }) {
  const alert = await ChildAlert.findOneAndUpdate(
    { _id: id, society: ctx.societyId, unit: ctx.unitId, status: 'open' },
    { status: 'acknowledged', acknowledgedBy: ctx.userId, acknowledgedAt: new Date(), response, ackNote: note },
    { returnDocument: 'after' },
  )
    .populate(ALERT_POPULATE)
    .lean();
  if (!alert) throw ApiError.conflict('Alert not found or already acknowledged');
  await notifyUsers(ctx.societyId, [alert.raisedBy._id], {
    type: 'child_alert',
    title: response === 'stop' ? `STOP ${alert.child.name} — parent asks to hold` : `${alert.child.name} may leave`,
    body: note || `Answered by ${ctx.user?.name || 'parent'}`,
    link: '/child-safety',
    channels: ['inapp', 'push'],
    urgent: response === 'stop',
  });
  if (response === 'stop') {
    await notifyRoles(ctx.societyId, [ROLES.GUARD], { type: 'child_alert', title: `Hold ${alert.child.name} at ${alert.gate}`, body: note || 'Parent asked to stop the child', link: '/child-safety', urgent: true });
  }
  invalidate(ctx.societyId, ['childAlerts'], { roles: [ROLES.GUARD], unit: ctx.unitId });
  return alert;
}

// Scheduler: alerts nobody answered within the society's limit go to management and all guards.
export async function escalateAlerts(lookupSettings, now = new Date()) {
  const open = await ChildAlert.find({ status: 'open', escalatedAt: null, createdAt: { $lte: new Date(now.getTime() - 60000) } }).populate(ALERT_POPULATE).limit(500).lean();
  const settingsFor = await lookupSettings([...new Set(open.map((a) => String(a.society)))]);
  let escalated = 0;
  for (const a of open) {
    const limit = settingsFor(a.society).childAlertEscalationMinutes * 60000;
    if (now - a.createdAt < limit) continue;
    // eslint-disable-next-line no-await-in-loop
    const claimed = await ChildAlert.updateOne({ _id: a._id, status: 'open', escalatedAt: null }, { escalatedAt: now });
    if (!claimed.modifiedCount) continue;
    escalated += 1;
    // eslint-disable-next-line no-await-in-loop
    await notifyRoles(a.society, [ROLES.ADMIN, ROLES.FACILITY_MANAGER, ROLES.GUARD], {
      type: 'child_alert',
      title: `No answer: ${a.child.name} (${a.unit.label}) left the gate`,
      body: `Parents have not responded for ${Math.round((now - a.createdAt) / 60000)} min. Please call the household.`,
      link: '/child-safety',
      channels: ['inapp', 'push', 'sms'],
      urgent: true,
    });
    // eslint-disable-next-line no-await-in-loop
    await notifyUnit(a.society, a.unit._id, { type: 'child_alert', title: `Reminder: ${a.child.name} left the gate`, body: 'Please respond in the app', link: '/child-safety', channels: ['inapp', 'push', 'sms'], urgent: true });
    invalidate(a.society, ['childAlerts']);
  }
  return { escalated };
}
