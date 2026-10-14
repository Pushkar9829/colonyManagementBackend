import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Parcel from './parcel.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { numericCode } from '../../common/utils/codes.js';
import { startOfLocalDay } from '../../common/utils/dates.js';
import { ROLES } from '../../common/constants/index.js';
import * as units from '../units/units.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { nextNumber } from '../counter/counter.service.js';
import { notifyUnit } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import * as prefs from './deliveryPreferences.service.js';
import * as gateSvc from '../gates/gates.service.js';

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
const OPEN = ['received', 'notified'];
const MAX_OTP_ATTEMPTS = 5;
const POPULATE = [
  { path: 'unit', select: 'label' },
  { path: 'receivedBy', select: 'name' },
  { path: 'handedOverBy', select: 'name' },
];

const refresh = (ctx, unit) => invalidate(ctx.societyId, ['parcels', 'dashboard'], { roles: [ROLES.GUARD], unit });
const withAge = (p, now = Date.now()) => ({ ...p, ageHours: Math.floor(((p.collectedAt || p.returnedAt || now) - new Date(p.receivedAt)) / 3600000) });

async function hasResidents(societyId, unitId) {
  return Membership.exists({ society: societyId, unit: unitId, role: ROLES.RESIDENT, status: 'active' });
}

// A gate that takes no deliveries refuses the parcel.
export async function create(ctx, { photo, visitorId, gateId, ...data }) {
  const unit = await units.assertUnit(ctx.societyId, data.unit);
  const gate = await gateSvc.resolveGate(ctx, gateId);
  await gateSvc.checkKind(ctx, gate, 'deliveries');
  const [file] = await uploads.resolve(ctx, photo ? [photo] : []);
  const pref = await prefs.findLeaveAtGate(ctx.societyId, unit._id, data.courier);
  const now = new Date();
  const notify = await hasResidents(ctx.societyId, unit._id);
  const parcel = await Parcel.create({
    ...data,
    society: ctx.societyId,
    number: await nextNumber(ctx.societyId, 'parcel', 'PCL'),
    photoUrl: file?.url,
    otp: numericCode(4),
    leftAtGate: Boolean(pref),
    visitor: visitorId,
    gate: gate._id,
    gateName: gate.name,
    receivedBy: ctx.userId,
    receivedAt: now,
    status: notify ? 'notified' : 'received',
    notifiedAt: notify ? now : undefined,
  });
  if (pref) await prefs.consume(pref, now);
  if (notify) {
    await notifyUnit(ctx.societyId, unit._id, {
      type: 'parcel',
      title: `Parcel from ${parcel.courier} at the gate`,
      body: `${parcel.number}${parcel.trackingNo ? ` · ${parcel.trackingNo}` : ''} · collect with OTP ${parcel.otp}`,
      link: '/parcels',
      channels: ['inapp', 'push'],
    });
  }
  refresh(ctx, unit._id);
  return withAge(await Parcel.findById(parcel._id).populate(POPULATE).lean());
}

export async function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  else if (filters.unit) filter.unit = filters.unit;
  if (filters.status) filter.status = filters.status;
  else if (filters.open) filter.status = { $in: OPEN };
  if (filters.gate) filter.gate = filters.gate;
  if (filters.olderThanHours) filter.receivedAt = { $lte: new Date(Date.now() - filters.olderThanHours * 3600000) };
  if (filters.search) {
    const rx = { $regex: escapeRegex(filters.search), $options: 'i' };
    filter.$or = [{ number: rx }, { trackingNo: rx }, { courier: rx }, { recipientName: rx }];
  }
  const result = await paginate(Parcel, filter, pagination, { sort: { receivedAt: -1 }, populate: POPULATE, select: isResident(ctx) ? '+otp' : undefined });
  const now = Date.now();
  // The OTP is shown only to the household and only while the parcel is waiting.
  result.items = result.items.map((p) => withAge(isResident(ctx) && OPEN.includes(p.status) ? p : { ...p, otp: undefined }, now));
  return result;
}

export async function getById(ctx, id) {
  const filter = { _id: id, society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  const q = Parcel.findOne(filter).populate(POPULATE);
  if (isResident(ctx)) q.select('+otp');
  const p = await q.lean();
  if (!p) throw ApiError.notFound('Parcel not found');
  if (!isResident(ctx) || !OPEN.includes(p.status)) delete p.otp;
  return withAge(p);
}

const otpMatches = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Guard hands the parcel over after the collector reads out the OTP from the resident's app.
export async function collect(ctx, id, { otp, collectedByType, collectedByName }) {
  const parcel = await Parcel.findOne({ _id: id, society: ctx.societyId }).select('+otp +otpAttempts');
  if (!parcel) throw ApiError.notFound('Parcel not found');
  if (!OPEN.includes(parcel.status)) throw ApiError.conflict(`Parcel is already ${parcel.status}`);
  if (parcel.otpAttempts >= MAX_OTP_ATTEMPTS) throw new ApiError(429, 'OTP_LOCKED', 'Too many wrong OTPs. Ask the resident to call the gate, or return the parcel.');
  if (!otpMatches(parcel.otp, otp)) {
    await Parcel.updateOne({ _id: parcel._id }, { $inc: { otpAttempts: 1 } });
    throw ApiError.badRequest(`Wrong OTP (${MAX_OTP_ATTEMPTS - parcel.otpAttempts - 1} attempts left)`);
  }
  const now = new Date();
  // Conditional update: two guards scanning the same parcel cannot both hand it over.
  const done = await Parcel.findOneAndUpdate(
    { _id: parcel._id, status: { $in: OPEN } },
    { status: 'collected', collectedAt: now, collectedBy: { type: collectedByType, name: collectedByName }, handedOverBy: ctx.userId },
    { returnDocument: 'after' },
  )
    .populate(POPULATE)
    .lean();
  if (!done) throw ApiError.conflict('Parcel was just handed over');
  await notifyUnit(ctx.societyId, done.unit._id, {
    type: 'parcel',
    title: `Parcel ${done.number} collected`,
    body: `Collected by ${collectedByName || collectedByType.replace('_', ' ')}`,
    link: '/parcels',
  });
  refresh(ctx, done.unit._id);
  return withAge(done);
}

export async function markReturned(ctx, id, { reason }) {
  const done = await Parcel.findOneAndUpdate(
    { _id: id, society: ctx.societyId, status: { $in: OPEN } },
    { status: 'returned', returnedAt: new Date(), returnReason: reason, handedOverBy: ctx.userId },
    { returnDocument: 'after' },
  )
    .populate(POPULATE)
    .lean();
  if (!done) throw ApiError.conflict('Only parcels waiting at the gate can be returned');
  audit.record(ctx, 'parcel.returned', 'Parcel', id, { reason });
  await notifyUnit(ctx.societyId, done.unit._id, { type: 'parcel', title: `Parcel ${done.number} returned to ${done.courier}`, body: reason, link: '/parcels' });
  refresh(ctx, done.unit._id);
  return withAge(done);
}

export async function remind(ctx, id) {
  const p = await Parcel.findOne({ _id: id, society: ctx.societyId, status: { $in: OPEN } }).select('+otp').lean();
  if (!p) throw ApiError.notFound('Waiting parcel not found');
  await sendReminder(p, new Date());
  return { reminded: true };
}

async function sendReminder(p, now) {
  const days = Math.max(1, Math.floor((now - p.receivedAt) / 86400000));
  await notifyUnit(p.society, p.unit, {
    type: 'parcel',
    title: `Parcel from ${p.courier} waiting ${days} day${days > 1 ? 's' : ''}`,
    body: `${p.number} · collect from the gate with OTP ${p.otp}`,
    link: '/parcels',
    channels: ['inapp', 'push'],
  });
  await Parcel.updateOne({ _id: p._id }, { $inc: { reminders: 1 }, lastReminderAt: now, ...(p.status === 'received' ? { status: 'notified', notifiedAt: now } : {}) });
}

export async function stats(ctx) {
  const now = Date.now();
  const [byStatus, waiting, collectedToday] = await Promise.all([
    Parcel.aggregate([{ $match: { society: new mongoose.Types.ObjectId(String(ctx.societyId)) } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Parcel.find({ society: ctx.societyId, status: { $in: OPEN } }).select('receivedAt').lean(),
    Parcel.countDocuments({ society: ctx.societyId, status: 'collected', collectedAt: { $gte: startOfLocalDay() } }),
  ]);
  const ageing = { under24h: 0, days1to3: 0, over3days: 0 };
  for (const p of waiting) {
    const h = (now - p.receivedAt) / 3600000;
    if (h < 24) ageing.under24h += 1;
    else if (h < 72) ageing.days1to3 += 1;
    else ageing.over3days += 1;
  }
  return { byStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.count])), waiting: waiting.length, ageing, collectedToday };
}

// Scheduler: reminds households about parcels waiting longer than the society's reminder interval.
export async function sendDueReminders(lookupSettings, now = new Date()) {
  const candidates = await Parcel.find({
    status: { $in: OPEN },
    receivedAt: { $lte: new Date(now.getTime() - 3600000) },
  })
    .select('+otp society unit number courier receivedAt lastReminderAt status')
    .limit(2000)
    .lean();
  const settingsFor = await lookupSettings([...new Set(candidates.map((p) => String(p.society)))]);
  let reminded = 0;
  for (const p of candidates) {
    const every = settingsFor(p.society).parcelReminderHours * 3600000;
    const last = p.lastReminderAt || p.receivedAt;
    if (now - p.receivedAt < every || now - last < every) continue;
    // eslint-disable-next-line no-await-in-loop
    await sendReminder(p, now);
    reminded += 1;
  }
  return { reminded };
}

// ---- delivery preferences ----
export const listPreferences = (ctx) => prefs.listForUnit(ctx, ctx.unitId);
export const createPreference = (ctx, data) => prefs.create(ctx, data);
export const removePreference = (ctx, id) => prefs.remove(ctx, id);
export async function checkPreference(ctx, { unit, company }) {
  await units.assertUnit(ctx.societyId, unit);
  const pref = await prefs.findLeaveAtGate(ctx.societyId, unit, company);
  return { leaveAtGate: Boolean(pref), preference: pref ? { company: pref.company || 'Any company', oneOff: Boolean(pref.oneOffDate), note: pref.note } : null };
}
