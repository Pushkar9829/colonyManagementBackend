import mongoose from 'mongoose';
import { EvCharger, EvSession, ParkingArea, ParkingSlot, ParkingViolation, VisitorParking } from './parking.model.js';
import Visitor from '../visitors/visitor.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { localDateString, toMinutes } from '../../common/utils/dates.js';
import { ROLES } from '../../common/constants/index.js';
import * as units from '../units/units.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import * as vehicles from '../vehicles/vehicles.service.js';
import { nextNumber } from '../counter/counter.service.js';
import { notifyRoles, notifyUnit } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import { localDateTime, normalizePlate } from '../visitors/gateTime.js';

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
const refresh = (ctx, unit) => invalidate(ctx.societyId, ['parking'], { roles: [ROLES.GUARD], unit });
const SLOT_POPULATE = [
  { path: 'area', select: 'name level' },
  { path: 'unit', select: 'label' },
  { path: 'vehicles', select: 'number type make color' },
];

// ---------- areas ----------
export async function listAreas(ctx) {
  const areas = await ParkingArea.find({ society: ctx.societyId }).sort({ name: 1 }).lean();
  const counts = await ParkingSlot.aggregate([
    { $match: { society: new mongoose.Types.ObjectId(String(ctx.societyId)), active: true } },
    { $group: { _id: '$area', total: { $sum: 1 }, allotted: { $sum: { $cond: [{ $ifNull: ['$unit', false] }, 1, 0] } }, visitor: { $sum: { $cond: [{ $eq: ['$pool', 'visitor'] }, 1, 0] } } } },
  ]);
  const byArea = new Map(counts.map((c) => [String(c._id), c]));
  return areas.map((a) => ({ ...a, slots: byArea.get(String(a._id))?.total || 0, allotted: byArea.get(String(a._id))?.allotted || 0, visitorSlots: byArea.get(String(a._id))?.visitor || 0 }));
}

export async function createArea(ctx, data) {
  try {
    const a = await ParkingArea.create({ ...data, society: ctx.societyId });
    return a.toObject();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('An area with this name exists');
    throw err;
  }
}

export async function updateArea(ctx, id, data) {
  const a = await ParkingArea.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: data }, { returnDocument: 'after' }).lean();
  if (!a) throw ApiError.notFound('Area not found');
  return a;
}

export async function removeArea(ctx, id) {
  if (await ParkingSlot.exists({ society: ctx.societyId, area: id })) throw ApiError.conflict('Remove the slots in this area first');
  const res = await ParkingArea.deleteOne({ _id: id, society: ctx.societyId });
  if (!res.deletedCount) throw ApiError.notFound('Area not found');
}

async function assertArea(ctx, id) {
  if (!(await ParkingArea.exists({ _id: id, society: ctx.societyId }))) throw ApiError.badRequest('Parking area not found');
}

// ---------- slots ----------
export async function listSlots(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.area) filter.area = filters.area;
  if (filters.pool) filter.pool = filters.pool;
  if (filters.type) filter.type = filters.type;
  if (filters.unit) filter.unit = filters.unit;
  if (filters.active !== undefined) filter.active = filters.active;
  if (filters.status === 'free') Object.assign(filter, { pool: 'resident', unit: null, active: true });
  if (filters.status === 'allotted') filter.unit = { $ne: null };
  if (filters.search) filter.number = { $regex: escapeRegex(filters.search.toUpperCase()) };
  const result = await paginate(ParkingSlot, filter, pagination, { sort: { number: 1 }, populate: SLOT_POPULATE });
  // Visitor-pool slots show whether a car is in them right now.
  const visitorIds = result.items.filter((s) => s.pool === 'visitor').map((s) => s._id);
  if (visitorIds.length) {
    const active = await VisitorParking.find({ society: ctx.societyId, slot: { $in: visitorIds }, status: 'active' }).populate('unit', 'label').lean();
    const bySlot = new Map(active.map((a) => [String(a.slot), a]));
    result.items = result.items.map((s) => (s.pool === 'visitor' ? { ...s, occupiedBy: bySlot.get(String(s._id)) || null } : s));
  }
  return result;
}

export async function createSlots(ctx, { area, number, prefix, from, to, ...rest }) {
  await assertArea(ctx, area);
  const numbers = number ? [number.toUpperCase()] : Array.from({ length: to - from + 1 }, (_, i) => `${prefix || ''}${from + i}`.toUpperCase());
  const existing = new Set((await ParkingSlot.find({ society: ctx.societyId, number: { $in: numbers } }).select('number').lean()).map((s) => s.number));
  if (number && existing.size) throw ApiError.conflict('Slot {slot} already exists', { params: { slot: number } });
  const docs = numbers.filter((n) => !existing.has(n)).map((n) => ({ ...rest, area, number: n, society: ctx.societyId }));
  if (docs.length) await ParkingSlot.insertMany(docs, { ordered: false });
  audit.record(ctx, 'parking.slots_created', 'ParkingSlot', null, { area, count: docs.length });
  refresh(ctx);
  return { created: docs.length, skipped: existing.size };
}

export async function updateSlot(ctx, id, data) {
  const slot = await ParkingSlot.findOne({ _id: id, society: ctx.societyId });
  if (!slot) throw ApiError.notFound('Slot not found');
  if (data.area) await assertArea(ctx, data.area);
  if (data.pool === 'visitor' && slot.unit) throw ApiError.conflict('Release the slot before moving it to the visitor pool');
  Object.assign(slot, data);
  try {
    await slot.save();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('Another slot already has this number');
    throw err;
  }
  refresh(ctx);
  return ParkingSlot.findById(slot._id).populate(SLOT_POPULATE).lean();
}

export async function removeSlot(ctx, id) {
  const slot = await ParkingSlot.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!slot) throw ApiError.notFound('Slot not found');
  if (slot.unit) throw ApiError.conflict('Release the slot before deleting it');
  if (await VisitorParking.exists({ slot: id, status: 'active' })) throw ApiError.conflict('A visitor car is parked in this slot');
  await ParkingSlot.deleteOne({ _id: id });
  refresh(ctx);
}

const fits = (slotType, vehicleType) => !(slotType === 'two_wheeler' && vehicleType !== 'two_wheeler');

// Allot a slot to a unit, optionally linking the unit's registered vehicles.
// The conditional update makes "two managers allot the same slot" fail for the second one.
export async function allot(ctx, id, { unit: unitId, vehicles: vehicleIds = [] }) {
  const slot = await ParkingSlot.findOne({ _id: id, society: ctx.societyId }).populate('unit', 'label').lean();
  if (!slot) throw ApiError.notFound('Slot not found');
  const unit = await units.assertUnit(ctx.societyId, unitId);
  if (!slot.active) throw ApiError.conflict('This slot is not in use');
  if (slot.pool === 'visitor') throw ApiError.conflict('Visitor-pool slots cannot be allotted to a unit');
  if (slot.unit && String(slot.unit._id) !== String(unit._id)) throw ApiError.conflict('Slot {slot} is already allotted to {unit}', { params: { slot: slot.number, unit: slot.unit.label } });

  const vs = vehicleIds.length ? await vehicles.findByIds(ctx.societyId, vehicleIds) : [];
  if (vs.length !== new Set(vehicleIds.map(String)).size) throw ApiError.badRequest('One or more vehicles are invalid');
  for (const v of vs) {
    if (String(v.unit) !== String(unit._id)) throw ApiError.badRequest('{vehicle} is not registered to {unit}', { params: { vehicle: v.number, unit: unit.label } });
    if (!fits(slot.type, v.type)) throw ApiError.badRequest('{vehicle} does not fit a {type} slot', { params: { vehicle: v.number, type: slot.type.replace('_', ' ') } });
  }
  const elsewhere = vs.length ? await ParkingSlot.findOne({ society: ctx.societyId, _id: { $ne: slot._id }, vehicles: { $in: vs.map((v) => v._id) } }).select('number').lean() : null;
  if (elsewhere) throw ApiError.conflict('A selected vehicle is already linked to slot {slot}', { params: { slot: elsewhere.number } });

  const updated = await ParkingSlot.findOneAndUpdate(
    { _id: slot._id, $or: [{ unit: null }, { unit: unit._id }] },
    { unit: unit._id, vehicles: vs.map((v) => v._id), allottedAt: slot.unit ? slot.allottedAt : new Date() },
    { returnDocument: 'after' },
  )
    .populate(SLOT_POPULATE)
    .lean();
  if (!updated) throw ApiError.conflict('Slot {slot} was just allotted to another unit', { params: { slot: slot.number } });

  const unlinked = (slot.vehicles || []).filter((v) => !vs.some((x) => String(x._id) === String(v)));
  await vehicles.setParkingSlot(ctx.societyId, unlinked, null);
  await vehicles.setParkingSlot(ctx.societyId, vs.map((v) => v._id), slot.number);
  audit.record(ctx, 'parking.slot_allotted', 'ParkingSlot', slot._id, { slot: slot.number, unit: unit.label, vehicles: vs.map((v) => v.number) });
  if (!slot.unit) await notifyUnit(ctx.societyId, unit._id, { type: 'parking', title: `Parking slot ${slot.number} allotted`, body: vs.length ? `For ${vs.map((v) => v.number).join(', ')}` : 'Link your vehicles in the app', link: '/parking' });
  refresh(ctx, unit._id);
  return updated;
}

export async function release(ctx, id) {
  const slot = await ParkingSlot.findOne({ _id: id, society: ctx.societyId, unit: { $ne: null } });
  if (!slot) throw ApiError.conflict('Slot is not allotted');
  const { unit, vehicles: linked } = slot;
  slot.unit = undefined;
  slot.vehicles = [];
  slot.allottedAt = undefined;
  await slot.save();
  await vehicles.setParkingSlot(ctx.societyId, linked, null);
  audit.record(ctx, 'parking.slot_released', 'ParkingSlot', slot._id, { slot: slot.number });
  await notifyUnit(ctx.societyId, unit, { type: 'parking', title: `Parking slot ${slot.number} released`, body: 'Contact the management office for details', link: '/parking' });
  refresh(ctx, unit);
  return ParkingSlot.findById(slot._id).populate(SLOT_POPULATE).lean();
}

// Resident's view: their slots, vehicles, open violations and upcoming EV bookings.
export async function mine(ctx) {
  if (!ctx.unitId) return { slots: [], vehicles: [], violations: [], evBookings: [] };
  const [slots, vs, violations, evBookings] = await Promise.all([
    ParkingSlot.find({ society: ctx.societyId, unit: ctx.unitId }).populate(SLOT_POPULATE).sort({ number: 1 }).lean(),
    vehicles.forUnit(ctx.societyId, ctx.unitId),
    ParkingViolation.find({ society: ctx.societyId, unit: ctx.unitId, status: { $in: ['open', 'disputed'] } }).sort({ createdAt: -1 }).lean(),
    EvSession.find({ society: ctx.societyId, unit: ctx.unitId, date: { $gte: localDateString() }, status: { $in: ['booked', 'charging'] } }).populate('charger', 'name location').sort({ date: 1, startTime: 1 }).lean(),
  ]);
  return { slots, vehicles: vs, violations, evBookings };
}

export async function summary(ctx) {
  const society = new mongoose.Types.ObjectId(String(ctx.societyId));
  const [slots, visitorsParked, overstays, openViolations, charging] = await Promise.all([
    ParkingSlot.aggregate([{ $match: { society, active: true } }, { $group: { _id: { pool: '$pool', allotted: { $cond: [{ $ifNull: ['$unit', false] }, true, false] } }, n: { $sum: 1 } } }]),
    VisitorParking.countDocuments({ society: ctx.societyId, status: 'active' }),
    VisitorParking.countDocuments({ society: ctx.societyId, status: 'active', expectedOutAt: { $lt: new Date() } }),
    ParkingViolation.countDocuments({ society: ctx.societyId, status: { $in: ['open', 'disputed'] } }),
    EvSession.countDocuments({ society: ctx.societyId, status: 'charging' }),
  ]);
  const count = (pool, allotted) => slots.find((s) => s._id.pool === pool && (allotted === undefined || s._id.allotted === allotted))?.n || 0;
  return {
    residentSlots: count('resident', true) + count('resident', false),
    allotted: count('resident', true),
    free: count('resident', false),
    visitorSlots: count('visitor', false) + count('visitor', true),
    visitorsParked,
    overstays,
    openViolations,
    charging,
  };
}

// ---------- visitor parking ----------
const VP_POPULATE = [
  { path: 'slot', select: 'number area', populate: { path: 'area', select: 'name' } },
  { path: 'unit', select: 'label' },
  { path: 'visitor', select: 'name phone' },
  { path: 'assignedBy', select: 'name' },
];

export async function startVisitorParking(ctx, { slot: slotId, vehicleNumber, visitorId, unit: unitId, hours, expectedOutAt }) {
  const slot = await ParkingSlot.findOne({ _id: slotId, society: ctx.societyId }).lean();
  if (!slot) throw ApiError.notFound('Slot not found');
  if (slot.pool !== 'visitor' || !slot.active) throw ApiError.conflict('Slot {slot} is not a visitor slot', { params: { slot: slot.number } });
  let unit = unitId;
  if (visitorId) {
    const v = await Visitor.findOne({ _id: visitorId, society: ctx.societyId }).select('unit vehicleNumber').lean();
    if (!v) throw ApiError.badRequest('Visitor not found');
    unit = v.unit;
  } else if (unit) await units.assertUnit(ctx.societyId, unit);
  const now = new Date();
  const out = expectedOutAt || new Date(now.getTime() + (hours || 2) * 3600000);
  if (out <= now) throw ApiError.badRequest('Expected out time must be in the future');
  try {
    const doc = await VisitorParking.create({ society: ctx.societyId, slot: slot._id, vehicleNumber: normalizePlate(vehicleNumber), visitor: visitorId, unit, inAt: now, expectedOutAt: out, assignedBy: ctx.userId });
    refresh(ctx);
    return VisitorParking.findById(doc._id).populate(VP_POPULATE).lean();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('Slot {slot} is occupied', { params: { slot: slot.number } });
    throw err;
  }
}

export async function endVisitorParking(ctx, id) {
  const doc = await VisitorParking.findOneAndUpdate({ _id: id, society: ctx.societyId, status: 'active' }, { status: 'completed', outAt: new Date(), endedBy: ctx.userId }, { returnDocument: 'after' })
    .populate(VP_POPULATE)
    .lean();
  if (!doc) throw ApiError.conflict('Session not found or already ended');
  refresh(ctx);
  return doc;
}

export function listVisitorParking(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.status) filter.status = filters.status;
  if (filters.overstay) Object.assign(filter, { status: 'active', expectedOutAt: { $lt: new Date() } });
  return paginate(VisitorParking, filter, pagination, { sort: { inAt: -1 }, populate: VP_POPULATE });
}

// Scheduler: visitor cars past their expected out time (+ grace) alert guards and the host household once.
export async function overstayAlerts(lookupSettings, now = new Date()) {
  const due = await VisitorParking.find({ status: 'active', expectedOutAt: { $lt: now }, overstayAlertedAt: null }).populate('slot', 'number').limit(1000).lean();
  const settingsFor = await lookupSettings([...new Set(due.map((d) => String(d.society)))]);
  let alerted = 0;
  for (const s of due) {
    const grace = settingsFor(s.society).visitorParkingOverstayGraceMinutes * 60000;
    if (now - s.expectedOutAt < grace) continue;
    // eslint-disable-next-line no-await-in-loop
    const claimed = await VisitorParking.updateOne({ _id: s._id, overstayAlertedAt: null }, { overstayAlertedAt: now });
    if (!claimed.modifiedCount) continue;
    alerted += 1;
    const mins = Math.round((now - s.expectedOutAt) / 60000);
    const payload = { type: 'parking', title: `Visitor car overstaying in ${s.slot?.number || 'visitor parking'}`, body: `${s.vehicleNumber} · ${mins} min past expected time`, link: '/parking?tab=visitors' };
    // eslint-disable-next-line no-await-in-loop
    await notifyRoles(s.society, [ROLES.GUARD, ROLES.FACILITY_MANAGER], payload);
    // eslint-disable-next-line no-await-in-loop
    if (s.unit) await notifyUnit(s.society, s.unit, { ...payload, title: `Your visitor's car ${s.vehicleNumber} has overstayed`, body: `Please ask them to move it from ${s.slot?.number || 'visitor parking'}` });
    invalidate(s.society, ['parking'], { roles: [ROLES.GUARD] });
  }
  return { alerted };
}

// ---------- violations ----------
const VIOLATION_POPULATE = [
  { path: 'unit', select: 'label' },
  { path: 'slot', select: 'number' },
  { path: 'reportedBy', select: 'name' },
  { path: 'resolvedBy', select: 'name' },
];

export async function reportViolation(ctx, { photos = [], slot, ...data }) {
  const files = await uploads.resolve(ctx, photos);
  if (slot && !(await ParkingSlot.exists({ _id: slot, society: ctx.societyId }))) throw ApiError.badRequest('Slot not found');
  const vehicle = await vehicles.findByPlate(ctx.societyId, data.vehicleNumber);
  const doc = await ParkingViolation.create({
    ...data,
    vehicleNumber: normalizePlate(data.vehicleNumber),
    society: ctx.societyId,
    number: await nextNumber(ctx.societyId, 'parking-violation', 'PV'),
    vehicle: vehicle?._id,
    unit: vehicle?.unit?._id,
    slot,
    photos: files,
    reportedBy: ctx.userId,
  });
  if (vehicle?.unit) {
    await notifyUnit(ctx.societyId, vehicle.unit._id, {
      type: 'parking',
      title: `Parking violation: ${doc.vehicleNumber}`,
      body: `${doc.type.replace(/_/g, ' ')}${doc.location ? ` at ${doc.location}` : ''}${doc.fine ? ` · ${doc.fine}` : ''}`,
      link: '/parking?tab=violations',
      channels: ['inapp', 'push'],
    });
  }
  audit.record(ctx, 'parking.violation_reported', 'ParkingViolation', doc._id, { vehicleNumber: doc.vehicleNumber, type: doc.type });
  refresh(ctx, vehicle?.unit?._id);
  return ParkingViolation.findById(doc._id).populate(VIOLATION_POPULATE).lean();
}

export function listViolations(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  if (filters.status) filter.status = filters.status;
  if (filters.search) filter.vehicleNumber = { $regex: escapeRegex(normalizePlate(filters.search)) };
  return paginate(ParkingViolation, filter, pagination, { populate: VIOLATION_POPULATE });
}

export async function disputeViolation(ctx, id, { note }) {
  const doc = await ParkingViolation.findOneAndUpdate({ _id: id, society: ctx.societyId, unit: ctx.unitId, status: 'open' }, { status: 'disputed', disputeNote: note }, { returnDocument: 'after' })
    .populate(VIOLATION_POPULATE)
    .lean();
  if (!doc) throw ApiError.conflict('Only open violations of your vehicles can be disputed');
  await notifyRoles(ctx.societyId, [ROLES.FACILITY_MANAGER], { type: 'parking', title: `Violation ${doc.number} disputed`, body: note, link: '/parking?tab=violations' });
  refresh(ctx, ctx.unitId);
  return doc;
}

export async function resolveViolation(ctx, id, { status, resolution }) {
  const doc = await ParkingViolation.findOneAndUpdate(
    { _id: id, society: ctx.societyId, status: { $in: ['open', 'disputed'] } },
    { status, resolution, resolvedBy: ctx.userId, resolvedAt: new Date() },
    { returnDocument: 'after' },
  )
    .populate(VIOLATION_POPULATE)
    .lean();
  if (!doc) throw ApiError.conflict('Violation not found or already closed');
  audit.record(ctx, 'parking.violation_closed', 'ParkingViolation', id, { status, resolution });
  if (doc.unit) await notifyUnit(ctx.societyId, doc.unit._id, { type: 'parking', title: `Violation ${doc.number} ${status}`, body: resolution, link: '/parking?tab=violations' });
  refresh(ctx, doc.unit?._id);
  return doc;
}

// ---------- EV charging ----------
export function listChargers(ctx, { all }) {
  const filter = { society: ctx.societyId };
  if (!all || isResident(ctx)) filter.active = true;
  return EvCharger.find(filter).sort({ name: 1 }).lean();
}

export async function createCharger(ctx, data) {
  const c = await EvCharger.create({ ...data, society: ctx.societyId });
  audit.record(ctx, 'parking.charger_created', 'EvCharger', c._id, { name: c.name });
  return c.toObject();
}

export async function updateCharger(ctx, id, data) {
  const c = await EvCharger.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: data }, { returnDocument: 'after' }).lean();
  if (!c) throw ApiError.notFound('Charger not found');
  return c;
}

const EV_POPULATE = [
  { path: 'charger', select: 'name location ratePerKwh' },
  { path: 'unit', select: 'label' },
  { path: 'user', select: 'name' },
  { path: 'vehicle', select: 'number' },
];
const LIVE = ['booked', 'charging'];

export async function availability(ctx, chargerId, date) {
  const charger = await EvCharger.findOne({ _id: chargerId, society: ctx.societyId, active: true }).lean();
  if (!charger) throw ApiError.notFound('Charger not found');
  const booked = await EvSession.find({ society: ctx.societyId, charger: charger._id, date, status: { $in: LIVE } }).select('startTime endTime status unit').populate('unit', 'label').sort({ startTime: 1 }).lean();
  return {
    charger,
    date,
    booked: booked.map((b) => ({ startTime: b.startTime, endTime: b.endTime, status: b.status, mine: isResident(ctx) ? String(b.unit?._id) === String(ctx.unitId) : undefined, unit: isResident(ctx) ? undefined : b.unit })),
  };
}

export async function book(ctx, { charger: chargerId, date, startTime, endTime, vehicle: vehicleId, unit: unitId }) {
  const unit = isResident(ctx) ? ctx.unitId : unitId;
  if (!unit) throw ApiError.badRequest(isResident(ctx) ? 'Only residents linked to a unit can book' : 'Unit is required');
  await units.assertUnit(ctx.societyId, unit);
  const charger = await EvCharger.findOne({ _id: chargerId, society: ctx.societyId, active: true }).lean();
  if (!charger) throw ApiError.notFound('Charger not found');
  const s = toMinutes(startTime);
  const e = toMinutes(endTime);
  if (e <= s) throw ApiError.badRequest('End time must be after start time');
  if (s < toMinutes(charger.openTime) || e > toMinutes(charger.closeTime)) throw ApiError.badRequest('Charger is available {open}–{close}', { params: { open: charger.openTime, close: charger.closeTime } });
  if ((e - s) % charger.slotMinutes !== 0) throw ApiError.badRequest('Book in blocks of {n} minutes', { params: { n: charger.slotMinutes } });
  if (e - s > charger.maxHoursPerBooking * 60) throw ApiError.badRequest('At most {n} hours per booking', { params: { n: charger.maxHoursPerBooking } });
  if (localDateTime(date, endTime) <= new Date()) throw ApiError.badRequest('This time has already passed');
  if (vehicleId) {
    const [v] = await vehicles.findByIds(ctx.societyId, [vehicleId]);
    if (!v || String(v.unit) !== String(unit)) throw ApiError.badRequest('Vehicle is not registered to this unit');
  }

  const overlap = { society: ctx.societyId, charger: charger._id, date, status: { $in: LIVE }, startTime: { $lt: endTime }, endTime: { $gt: startTime } };
  if (await EvSession.exists(overlap)) throw ApiError.conflict('This charger is already booked for part of that time');
  const doc = await EvSession.create({ society: ctx.societyId, charger: charger._id, unit, user: ctx.userId, vehicle: vehicleId, date, startTime, endTime });
  // Optimistic check: if two bookings raced in, the later one (by _id) gives way.
  const clash = await EvSession.findOne({ ...overlap, _id: { $ne: doc._id } }).sort({ _id: 1 }).lean();
  if (clash && clash._id < doc._id) {
    await EvSession.deleteOne({ _id: doc._id });
    throw ApiError.conflict('This charger was just booked for that time');
  }
  refresh(ctx, unit);
  return EvSession.findById(doc._id).populate(EV_POPULATE).lean();
}

export function listBookings(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  if (filters.charger) filter.charger = filters.charger;
  if (filters.date) filter.date = filters.date;
  if (filters.status) filter.status = filters.status;
  return paginate(EvSession, filter, pagination, { sort: { date: -1, startTime: -1 }, populate: EV_POPULATE });
}

async function getSession(ctx, id) {
  const filter = { _id: id, society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  const s = await EvSession.findOne(filter);
  if (!s) throw ApiError.notFound('Booking not found');
  return s;
}

export async function startCharging(ctx, id) {
  const s = await getSession(ctx, id);
  if (s.status !== 'booked') throw ApiError.conflict('Booking is {status}', { params: { status: s.status } });
  s.status = 'charging';
  s.startedAt = new Date();
  await s.save();
  refresh(ctx, s.unit);
  return EvSession.findById(s._id).populate(EV_POPULATE).lean();
}

// kWh is read off the charger display; cost is an estimate for the billing team.
export async function completeCharging(ctx, id, { kwh }) {
  const s = await getSession(ctx, id);
  if (!LIVE.includes(s.status)) throw ApiError.conflict('Booking is {status}', { params: { status: s.status } });
  const charger = await EvCharger.findById(s.charger).select('ratePerKwh').lean();
  s.status = 'completed';
  s.startedAt = s.startedAt || new Date();
  s.endedAt = new Date();
  s.kwh = kwh;
  s.costEstimate = Math.round(kwh * (charger?.ratePerKwh || 0));
  s.recordedBy = ctx.userId;
  await s.save();
  audit.record(ctx, 'parking.ev_session_completed', 'EvSession', s._id, { kwh, costEstimate: s.costEstimate });
  refresh(ctx, s.unit);
  return EvSession.findById(s._id).populate(EV_POPULATE).lean();
}

export async function cancelBooking(ctx, id, { noShow } = {}) {
  const s = await getSession(ctx, id);
  if (s.status !== 'booked') throw ApiError.conflict('Only bookings that have not started can be cancelled');
  // Staff mark no-shows; anyone may cancel a booking that has not started.
  s.status = noShow && !isResident(ctx) ? 'no_show' : 'cancelled';
  await s.save();
  refresh(ctx, s.unit);
  return EvSession.findById(s._id).populate(EV_POPULATE).lean();
}
