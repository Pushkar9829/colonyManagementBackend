import crypto from 'node:crypto';
import Visitor from './visitor.model.js';
import GuestPass from './guestPass.model.js';
import FrequentVisitor from './frequentVisitor.model.js';
import Society from '../society/society.model.js';
import Membership from '../users/membership.model.js';
import env from '../../config/env.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { numericCode } from '../../common/utils/codes.js';
import { ROLES } from '../../common/constants/index.js';
import * as units from '../units/units.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as vehicles from '../vehicles/vehicles.service.js';
import * as deliveryPrefs from '../parcels/deliveryPreferences.service.js';
import * as watchlist from './watchlist.service.js';
import * as gateSvc from '../gates/gates.service.js';
import { notifyRoles, notifyUnit } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import { eventTime, inWeeklyWindow, normalizePhone } from './gateTime.js';

// Gate screens (guards) and the household both watch visitor lists.
const refreshGate = (ctx, unit) => invalidate(ctx.societyId, ['visitors', 'dashboard'], { roles: ['guard'], unit });

const POPULATE = [
  { path: 'unit', select: 'label' },
  { path: 'loggedBy', select: 'name' },
  { path: 'respondedBy', select: 'name' },
];

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const blockedError = (name, reason) => new ApiError(403, 'VISITOR_BLOCKED', 'Entry refused: {name} is on the society blocklist ({reason}). Management has been alerted.', { params: { name, reason } });

function resolveTime(occurredAt) {
  const t = eventTime(occurredAt);
  if (!t) throw ApiError.badRequest('This offline entry is more than 7 days old and cannot be synced');
  return t;
}

async function byClientKey(ctx, clientKey) {
  if (!clientKey) return null;
  return Visitor.findOne({ society: ctx.societyId, clientKey }).populate(POPULATE).lean();
}

// Same answer for a retried request: the stored entry, or the same refusal if it was blocked.
function replay(existing) {
  if (existing.status === 'denied' && existing.flag?.type === 'block') throw blockedError(existing.name, existing.flag.reason);
  return { ...existing, duplicate: true };
}

// ---------- gate entries ----------
const gateKind = (purpose) => (purpose === 'delivery' ? 'deliveries' : 'visitors');

export async function logEntry(ctx, { photo, clientKey, occurredAt, guardApproved, gateId, ...data }) {
  const existing = await byClientKey(ctx, clientKey);
  if (existing) return replay(existing);

  const unit = await units.assertUnit(ctx.societyId, data.unit);
  const at = resolveTime(occurredAt);
  const gate = await gateSvc.resolveGate(ctx, gateId);
  const [photoFile] = await uploads.resolve(ctx, photo ? [photo] : []);
  const base = {
    ...data,
    photoUrl: photoFile?.url,
    society: ctx.societyId,
    loggedBy: ctx.userId,
    occurredAt: at,
    clientKey,
    offline: Boolean(clientKey && occurredAt),
    entryGate: gate._id,
    entryGateName: gate.name,
  };

  // 1. Blocklist: refuse, keep a record, alert management.
  const hit = await watchlist.screen(ctx.societyId, data, at);
  if (hit.block) {
    const denied = await createOnce(ctx, { ...base, status: 'denied', respondedAt: at, note: 'Refused: on the society blocklist', flag: { type: 'block', reason: hit.block.reason, entry: hit.block._id } });
    if (denied.duplicate) return replay(denied);
    await watchlist.alertHit(ctx.societyId, hit.block, { subject: data.name, unitLabel: unit.label });
    vehicles.logVisitorVehicle(ctx, denied);
    refreshGate(ctx, unit._id);
    throw blockedError(data.name, hit.block.reason);
  }

  // 2. Gate rules: e.g. a service gate takes no visitors. The guard may still let them in once the
  //    resident confirmed by phone; that is kept as an override.
  const rule = await gateSvc.checkKind(ctx, gate, gateKind(data.purpose), { withVehicle: Boolean(data.vehicleNumber), override: guardApproved });
  if (rule) base.gateOverride = rule.override;

  // 3. Decide whether the household must approve.
  let status = 'pending';
  let pref = null;
  let frequent = null;
  const extra = {};
  if (data.purpose === 'delivery') pref = await deliveryPrefs.findLeaveAtGate(ctx.societyId, unit._id, data.company, at);
  const phoneKey = normalizePhone(data.phone);
  if (phoneKey) frequent = await FrequentVisitor.findOne({ society: ctx.societyId, unit: unit._id, phoneKey }).lean();

  if (pref) {
    // The delivery person leaves the parcel at the gate and does not go in.
    Object.assign(extra, { leftAtGate: true, checkInAt: at, checkOutAt: at, exitGate: gate._id, exitGateName: gate.name, note: 'Left at gate (household preference)' });
    status = 'checked_out';
  } else if (frequent?.autoApprove) {
    Object.assign(extra, { autoApproved: true, checkInAt: at, note: 'Auto-approved frequent visitor' });
    status = 'checked_in';
  } else if (guardApproved) {
    Object.assign(extra, { checkInAt: at, respondedBy: ctx.userId, respondedAt: at, note: 'Allowed by guard after phone confirmation' });
    status = 'checked_in';
  } else {
    const society = await Society.findById(ctx.societyId).select('settings.visitorApprovalRequired').lean();
    if (society?.settings?.visitorApprovalRequired === false) {
      status = 'checked_in';
      extra.checkInAt = at;
    }
  }
  if (frequent) extra.frequentVisitor = frequent._id;
  if (hit.watch) extra.flag = { type: 'watch', reason: hit.watch.reason, entry: hit.watch._id };

  const visitor = await createOnce(ctx, { ...base, ...extra, status });
  if (visitor.duplicate) return replay(visitor);

  if (pref) await deliveryPrefs.consume(pref, at);
  if (frequent) await FrequentVisitor.updateOne({ _id: frequent._id }, { $inc: { visits: 1 }, lastVisitAt: at });
  if (hit.watch) await watchlist.alertHit(ctx.societyId, hit.watch, { subject: data.name, unitLabel: unit.label });
  vehicles.logVisitorVehicle(ctx, visitor);

  const titles = {
    pending: `${visitor.name} is at the gate`,
    checked_in: `${visitor.name} has entered`,
    checked_out: `${visitor.company || 'Delivery'} parcel left at the gate`,
  };
  await notifyUnit(ctx.societyId, unit._id, {
    type: 'visitor',
    title: titles[status],
    body: `${visitor.purpose}${visitor.company ? ` · ${visitor.company}` : ''}${visitor.autoApproved ? ' · auto-approved' : ''}`,
    link: '/visitors',
  });
  refreshGate(ctx, unit._id);
  const out = await Visitor.findById(visitor._id).populate(POPULATE).lean();
  return { ...out, leaveAtGate: Boolean(pref), watch: watchlist.matchSummary(hit.watch) || undefined };
}

// Create guarded by the (society, clientKey) unique index, so two concurrent retries make one entry.
async function createOnce(ctx, doc) {
  try {
    return (await Visitor.create(doc)).toObject();
  } catch (err) {
    if (err.code === 11000 && doc.clientKey) return { ...(await byClientKey(ctx, doc.clientKey)), duplicate: true };
    throw err;
  }
}

export function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  else if (filters.unit) filter.unit = filters.unit;
  if (filters.status) filter.status = filters.status;
  if (filters.purpose) filter.purpose = filters.purpose;
  if (filters.gate) filter.entryGate = filters.gate;
  if (filters.flagged === true) filter['flag.type'] = { $in: ['watch', 'block'] };
  if (filters.from || filters.to) {
    filter.createdAt = {};
    if (filters.from) filter.createdAt.$gte = filters.from;
    if (filters.to) filter.createdAt.$lt = filters.to;
  }
  if (filters.search) {
    const rx = { $regex: escapeRegex(filters.search), $options: 'i' };
    filter.$or = [{ name: rx }, { phone: rx }, { vehicleNumber: rx }];
  }
  return paginate(Visitor, filter, pagination, { populate: POPULATE });
}

async function getForAction(ctx, id) {
  const filter = { _id: id, society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  const visitor = await Visitor.findOne(filter);
  if (!visitor) throw ApiError.notFound('Visitor not found');
  return visitor;
}

// Resident decision. Approval lets the visitor in straight away.
export async function respond(ctx, id, approve, note) {
  const visitor = await getForAction(ctx, id);
  if (visitor.status !== 'pending') throw ApiError.conflict('Visitor is already {status}', { params: { status: visitor.status.replace('_', ' ') } });
  visitor.status = approve ? 'checked_in' : 'denied';
  visitor.respondedBy = ctx.userId;
  visitor.respondedAt = new Date();
  visitor.callResident = false;
  if (approve) visitor.checkInAt = new Date();
  if (note) visitor.note = note;
  await visitor.save();
  refreshGate(ctx, visitor.unit);
  return Visitor.findById(visitor._id).populate(POPULATE).lean();
}

// Guard turns a waiting visitor away (household said no on the phone, or nobody is home).
export function guardSendBack(ctx, id, note) {
  return respond(ctx, id, false, note || 'Sent back by guard');
}

// Guard override, e.g. resident confirmed on a phone call.
export async function guardCheckIn(ctx, id, note) {
  const visitor = await getForAction(ctx, id);
  if (visitor.status !== 'pending') throw ApiError.conflict('Visitor is already {status}', { params: { status: visitor.status.replace('_', ' ') } });
  visitor.status = 'checked_in';
  visitor.checkInAt = new Date();
  visitor.respondedBy = ctx.userId;
  visitor.respondedAt = new Date();
  visitor.callResident = false;
  visitor.note = note || 'Allowed by guard';
  await visitor.save();
  refreshGate(ctx, visitor.unit);
  return Visitor.findById(visitor._id).populate(POPULATE).lean();
}

// `occurredAt` comes from the offline queue; it never goes before the check-in time.
// Visitors may leave by any gate; the exit gate is recorded.
export async function checkOut(ctx, id, { occurredAt, gateId } = {}) {
  const visitor = await getForAction(ctx, id);
  if (visitor.status === 'checked_out') throw ApiError.conflict(`Already checked out at ${visitor.checkOutAt?.toISOString() || 'an earlier time'}`);
  if (visitor.status !== 'checked_in') throw ApiError.conflict('Only visitors inside can be checked out');
  const at = resolveTime(occurredAt);
  const gate = await gateSvc.resolveGate(ctx, gateId);
  visitor.exitGate = gate._id;
  visitor.exitGateName = gate.name;
  visitor.status = 'checked_out';
  visitor.checkOutAt = visitor.checkInAt && at < visitor.checkInAt ? visitor.checkInAt : at;
  await visitor.save();
  refreshGate(ctx, visitor.unit);
  return Visitor.findById(visitor._id).populate(POPULATE).lean();
}

// Household members' phones for the guard to call (IVR fallback is a human phone call).
export async function householdContacts(ctx, id) {
  const visitor = await getForAction(ctx, id);
  const members = await Membership.find({ society: ctx.societyId, unit: visitor.unit, role: ROLES.RESIDENT, status: 'active' })
    .populate('user', 'name phone')
    .select('user residentType')
    .lean();
  return members.filter((m) => m.user).map((m) => ({ name: m.user.name, phone: m.user.phone || null, residentType: m.residentType }));
}

// ---------- pre-approved passes ----------
async function uniqueActiveCode(societyId) {
  for (let i = 0; i < 10; i += 1) {
    const code = numericCode(6);
    // eslint-disable-next-line no-await-in-loop
    if (!(await GuestPass.exists({ society: societyId, code, status: 'active' }))) return code;
  }
  throw new Error('Could not generate a pass code');
}

// QR payload: pass id + HMAC, so a QR cannot be forged from a guessed id and stays valid only with the server secret.
const sign = (id, code) => crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`pass:${id}:${code}`).digest('base64url').slice(0, 22);
export const qrToken = (pass) => `CHP1.${pass._id}.${sign(pass._id, pass.code)}`;
const withQr = (pass) => ({ ...pass, qrToken: qrToken(pass) });

function parseQr(qr) {
  const m = /^CHP1\.([a-f0-9]{24})\.([A-Za-z0-9_-]{22})$/.exec(qr.trim());
  return m ? { id: m[1], sig: m[2] } : null;
}

const windowText = (r) => `${r.days.map((d) => DAY_NAMES[d]).join(', ')} ${r.startTime}–${r.endTime}`;

export async function createPass(ctx, { recurrence, gates = [], ...data }) {
  if (!ctx.unitId) throw ApiError.badRequest('Only residents linked to a unit can create passes');
  const pass = await GuestPass.create({
    ...data,
    gates: await gateSvc.assertGateIds(ctx.societyId, gates),
    ...(recurrence ? { kind: 'recurring', recurrence: { ...recurrence, days: [...new Set(recurrence.days)].sort() }, maxUses: 1 } : {}),
    society: ctx.societyId,
    unit: ctx.unitId,
    createdBy: ctx.userId,
    code: await uniqueActiveCode(ctx.societyId),
  });
  if (pass.gates.length) await pass.populate('gates', 'name code');
  return withQr(pass.toObject());
}

export async function listPasses(ctx, filters, pagination) {
  // Expire lazily so lists stay correct without a cron job.
  await GuestPass.updateMany({ society: ctx.societyId, status: 'active', validTo: { $lt: new Date() } }, { status: 'expired' });
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  if (filters.status) filter.status = filters.status;
  if (filters.kind) filter.kind = filters.kind === 'one_time' ? { $ne: 'recurring' } : 'recurring';
  const result = await paginate(GuestPass, filter, pagination, { populate: [{ path: 'unit', select: 'label' }, { path: 'gates', select: 'name code' }] });
  // Only the household gets the QR; guards see the list without it.
  if (isResident(ctx)) result.items = result.items.map(withQr);
  return result;
}

export async function cancelPass(ctx, id) {
  const filter = { _id: id, society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  const pass = await GuestPass.findOneAndUpdate({ ...filter, status: 'active' }, { status: 'cancelled' }, { returnDocument: 'after' }).lean();
  if (!pass) throw ApiError.notFound('Active pass not found');
  return pass;
}

async function findPassForGate(ctx, code, qr) {
  const raw = code || qr.trim();
  if (/^\d{6}$/.test(raw)) {
    const pass = await GuestPass.findOne({ society: ctx.societyId, code: raw, status: 'active' });
    if (!pass) throw ApiError.notFound('Invalid or already used code');
    return pass;
  }
  const parsed = parseQr(raw);
  if (!parsed) throw ApiError.badRequest('This QR code is not a ColonyHub guest pass');
  const pass = await GuestPass.findOne({ _id: parsed.id, society: ctx.societyId });
  const expected = pass && sign(pass._id, pass.code);
  if (!pass || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.sig))) throw ApiError.notFound('Invalid pass QR code');
  if (pass.status !== 'active') throw ApiError.notFound('This pass is {status}', { params: { status: pass.status } });
  return pass;
}

// Guard verifies a typed code or a scanned QR. opts: { qr, occurredAt, clientKey } (offline mode),
// gateId (where the guard is) and guardApproved (resident confirmed by phone: overrides a gate refusal).
export async function verifyPass(ctx, code, { qr, occurredAt, clientKey, gateId, guardApproved } = {}) {
  const existing = await byClientKey(ctx, clientKey);
  if (existing) return replay(existing);
  const now = resolveTime(occurredAt);
  const gate = await gateSvc.resolveGate(ctx, gateId);
  const pass = await findPassForGate(ctx, code, qr);
  if (now < pass.validFrom) throw ApiError.badRequest('This pass is not valid yet');
  if (now > pass.validTo) {
    if (!occurredAt) {
      pass.status = 'expired';
      await pass.save();
    }
    throw ApiError.badRequest('This pass has expired');
  }
  const recurring = pass.kind === 'recurring';
  if (recurring && !inWeeklyWindow(now, pass.recurrence)) {
    throw ApiError.badRequest("Outside this pass's time window ({window})", { params: { window: windowText(pass.recurrence) } });
  }

  const hit = await watchlist.screen(ctx.societyId, { name: pass.guestName, phone: pass.phone }, now);
  const unit = await units.assertUnit(ctx.societyId, pass.unit);
  if (hit.block) {
    await watchlist.alertHit(ctx.societyId, hit.block, { subject: pass.guestName, unitLabel: unit.label });
    throw blockedError(pass.guestName, hit.block.reason);
  }
  if (recurring && (await Visitor.exists({ society: ctx.societyId, pass: pass._id, status: 'checked_in' }))) {
    throw ApiError.conflict('{name} is already inside on this pass', { params: { name: pass.guestName } });
  }
  // Checked before the use count changes, so a refused scan does not use up the pass.
  const listRule = await gateSvc.checkListed(ctx, gate, pass.gates, { override: guardApproved });
  const kindRule = await gateSvc.checkKind(ctx, gate, gateKind(pass.purpose), { override: guardApproved });
  const gateOverride = (listRule || kindRule)?.override;

  // Atomic use-count increment prevents double entry on concurrent scans. Recurring passes are not used up.
  const cond = { _id: pass._id, status: 'active' };
  if (!recurring) cond.usedCount = { $lt: pass.maxUses };
  const used = await GuestPass.findOneAndUpdate(cond, { $inc: { usedCount: 1 }, lastUsedAt: now }, { returnDocument: 'after' });
  if (!used) throw ApiError.conflict('This pass has no entries left');
  if (!recurring && used.usedCount >= used.maxUses) await GuestPass.updateOne({ _id: used._id }, { status: 'used' });

  const visitor = await createOnce(ctx, {
    society: ctx.societyId,
    unit: used.unit,
    name: used.guestName,
    phone: used.phone,
    purpose: used.purpose,
    status: 'checked_in',
    pass: used._id,
    loggedBy: ctx.userId,
    checkInAt: now,
    occurredAt: now,
    clientKey,
    offline: Boolean(clientKey && occurredAt),
    frequentVisitor: used.frequentVisitor,
    entryGate: gate._id,
    entryGateName: gate.name,
    ...(gateOverride ? { gateOverride } : {}),
    note: recurring ? 'Recurring pass' : 'Pre-approved pass',
    ...(hit.watch ? { flag: { type: 'watch', reason: hit.watch.reason, entry: hit.watch._id } } : {}),
  });
  if (visitor.duplicate) return replay(visitor);
  if (hit.watch) await watchlist.alertHit(ctx.societyId, hit.watch, { subject: used.guestName, unitLabel: unit.label });
  if (used.frequentVisitor) await FrequentVisitor.updateOne({ _id: used.frequentVisitor }, { $inc: { visits: 1 }, lastVisitAt: now });
  await notifyUnit(ctx.societyId, used.unit, { type: 'visitor', title: `${used.guestName} has entered`, body: recurring ? 'Recurring pass used' : 'Pre-approved pass used', link: '/visitors' });
  refreshGate(ctx, used.unit);
  const out = await Visitor.findById(visitor._id).populate(POPULATE).lean();
  return { ...out, watch: watchlist.matchSummary(hit.watch) || undefined };
}

// ---------- frequent visitors ----------
const FREQUENT_POPULATE = { path: 'unit', select: 'label' };

export function listFrequent(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  else if (filters.unit) filter.unit = filters.unit;
  if (filters.search) {
    const rx = { $regex: escapeRegex(filters.search), $options: 'i' };
    filter.$or = [{ name: rx }, { phone: rx }];
  }
  return paginate(FrequentVisitor, filter, pagination, { sort: { visits: -1, name: 1 }, populate: FREQUENT_POPULATE });
}

export async function createFrequent(ctx, body) {
  if (!ctx.unitId) throw ApiError.badRequest('Only residents linked to a unit can save frequent visitors');
  let data = body;
  if (body.fromVisitor) {
    const v = await Visitor.findOne({ _id: body.fromVisitor, society: ctx.societyId, unit: ctx.unitId }).lean();
    if (!v) throw ApiError.notFound('Visitor not found');
    data = { name: v.name, phone: v.phone, purpose: v.purpose, company: v.company, vehicleNumber: v.vehicleNumber, autoApprove: body.autoApprove };
  }
  const phoneKey = normalizePhone(data.phone) || undefined;
  if (phoneKey && (await FrequentVisitor.exists({ society: ctx.societyId, unit: ctx.unitId, phoneKey }))) {
    throw ApiError.conflict('This visitor is already in your frequent list');
  }
  if (data.autoApprove && !phoneKey) throw ApiError.badRequest('Auto-approve needs a phone number, so the guard can match the visitor');
  const doc = await FrequentVisitor.create({ ...data, phoneKey, society: ctx.societyId, unit: ctx.unitId, createdBy: ctx.userId });
  return doc.toObject();
}

export async function updateFrequent(ctx, id, data) {
  const doc = await FrequentVisitor.findOne({ _id: id, society: ctx.societyId, unit: ctx.unitId });
  if (!doc) throw ApiError.notFound('Frequent visitor not found');
  Object.assign(doc, data);
  doc.phoneKey = normalizePhone(doc.phone) || undefined;
  if (doc.autoApprove && !doc.phoneKey) throw ApiError.badRequest('Auto-approve needs a phone number, so the guard can match the visitor');
  await doc.save();
  return doc.toObject();
}

export async function removeFrequent(ctx, id) {
  const res = await FrequentVisitor.deleteOne({ _id: id, society: ctx.societyId, unit: ctx.unitId });
  if (!res.deletedCount) throw ApiError.notFound('Frequent visitor not found');
}

// One tap: a pass for a saved visitor, valid from now (or validFrom) for `hours`.
export async function passForFrequent(ctx, id, { validFrom, hours, maxUses }) {
  const fv = await FrequentVisitor.findOne({ _id: id, society: ctx.societyId, unit: ctx.unitId }).lean();
  if (!fv) throw ApiError.notFound('Frequent visitor not found');
  const from = validFrom || new Date();
  const pass = await createPass(ctx, { guestName: fv.name, phone: fv.phone, purpose: fv.purpose, validFrom: from, validTo: new Date(from.getTime() + hours * 3600000), maxUses });
  await GuestPass.updateOne({ _id: pass._id }, { frequentVisitor: fv._id });
  return { ...pass, frequentVisitor: fv._id };
}

// ---------- escalation (IVR fallback) ----------
// Pending visitors the household has not answered: re-alert every household member on push + SMS and
// put "call resident" on the guard's screen. Runs from the scheduler; safe to call repeatedly.
export async function escalatePending(lookupSettings, now = new Date()) {
  const candidates = await Visitor.find({ status: 'pending', escalatedAt: null, createdAt: { $lte: new Date(now.getTime() - 15000) } })
    .select('society unit name purpose company createdAt')
    .populate('unit', 'label')
    .limit(500)
    .lean();
  const settingsFor = await lookupSettings([...new Set(candidates.map((v) => String(v.society)))]);
  let escalated = 0;
  for (const v of candidates) {
    const { escalationSeconds } = settingsFor(v.society);
    if (now - v.createdAt < escalationSeconds * 1000) continue;
    // eslint-disable-next-line no-await-in-loop
    const claimed = await Visitor.updateOne({ _id: v._id, status: 'pending', escalatedAt: null }, { escalatedAt: now, callResident: true });
    if (!claimed.modifiedCount) continue;
    escalated += 1;
    // eslint-disable-next-line no-await-in-loop
    await notifyUnit(v.society, v.unit._id, {
      type: 'visitor',
      title: `${v.name} is still waiting at the gate`,
      body: 'Please approve or deny in the app. The guard will call you.',
      link: '/visitors',
      channels: ['inapp', 'push', 'sms'],
    });
    // eslint-disable-next-line no-await-in-loop
    await notifyRoles(v.society, [ROLES.GUARD], {
      type: 'visitor',
      title: `Call resident: ${v.unit.label}`,
      body: `${v.name} (${v.purpose}${v.company ? ` · ${v.company}` : ''}) — no response in ${escalationSeconds}s`,
      link: '/gate',
    });
    invalidate(v.society, ['visitors'], { roles: ['guard'], unit: v.unit._id });
  }
  return { escalated };
}

