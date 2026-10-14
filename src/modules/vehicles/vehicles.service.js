import Vehicle from './vehicle.model.js';
import VehicleMovement from './vehicleMovement.model.js';
import Visitor from '../visitors/visitor.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { ROLES } from '../../common/constants/index.js';
import * as units from '../units/units.service.js';
import * as audit from '../audit/audit.service.js';
import * as watchlist from '../visitors/watchlist.service.js';
import { getSettings } from '../visitors/securitySettings.service.js';
import * as gateSvc from '../gates/gates.service.js';
import { normalizePlate } from '../visitors/gateTime.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
const isManager = (ctx) => [ROLES.ADMIN, ROLES.FACILITY_MANAGER].includes(ctx.role);
const UNKNOWN_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const MOVEMENT_POPULATE = [
  { path: 'unit', select: 'label' },
  { path: 'vehicle', select: 'number type make color' },
  { path: 'visitor', select: 'name status' },
  { path: 'device', select: 'name type' },
  { path: 'loggedBy', select: 'name' },
];

export function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  else if (filters.unit) filter.unit = filters.unit;
  if (filters.search) filter.number = { $regex: escapeRegex(filters.search.replace(/\s+/g, '').toUpperCase()) };
  return paginate(Vehicle, filter, pagination, { populate: [{ path: 'unit', select: 'label' }, { path: 'owner', select: 'name' }] });
}

export async function create(ctx, data) {
  const unitId = isResident(ctx) ? ctx.unitId : data.unit;
  if (!unitId) throw ApiError.badRequest('Unit is required');
  await units.assertUnit(ctx.societyId, unitId);
  // RFID tags are issued by management, not self-assigned.
  const { rfidTag, ...rest } = data;
  const doc = { ...rest, unit: unitId, society: ctx.societyId, owner: isResident(ctx) ? ctx.userId : undefined };
  if (isManager(ctx) && rfidTag) doc.rfidTag = rfidTag;
  try {
    return await Vehicle.create(doc);
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict(err.keyPattern?.rfidTag ? 'This RFID tag is already assigned' : 'This vehicle is already registered');
    throw err;
  }
}

async function getOwned(ctx, id) {
  const filter = { _id: id, society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  const vehicle = await Vehicle.findOne(filter);
  if (!vehicle) throw ApiError.notFound('Vehicle not found');
  return vehicle;
}

export async function update(ctx, id, data) {
  const vehicle = await getOwned(ctx, id);
  const { rfidTag, ...rest } = data;
  Object.assign(vehicle, rest);
  if (isManager(ctx) && rfidTag !== undefined) vehicle.rfidTag = rfidTag || undefined;
  try {
    return await vehicle.save();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict(err.keyPattern?.rfidTag ? 'This RFID tag is already assigned' : 'This vehicle is already registered');
    throw err;
  }
}

export async function remove(ctx, id) {
  const vehicle = await getOwned(ctx, id);
  await vehicle.deleteOne();
}

// Management issues / clears the RFID tag of any vehicle.
export async function setRfidTag(ctx, id, rfidTag) {
  const vehicle = await Vehicle.findOne({ _id: id, society: ctx.societyId });
  if (!vehicle) throw ApiError.notFound('Vehicle not found');
  vehicle.rfidTag = rfidTag || undefined;
  try {
    await vehicle.save();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('This RFID tag is already assigned to another vehicle');
    throw err;
  }
  audit.record(ctx, 'vehicle.rfid_set', 'Vehicle', id, { rfidTag: vehicle.rfidTag || null });
  return Vehicle.findById(id).populate('unit', 'label').lean();
}

// Vehicles of one unit (used by parking allotment).
export const forUnit = (societyId, unitId) => Vehicle.find({ society: societyId, unit: unitId }).lean();
export const findByPlate = (societyId, plate) => Vehicle.findOne({ society: societyId, number: normalizePlate(plate) }).populate('unit', 'label').lean();
export const findByIds = (societyId, ids) => Vehicle.find({ society: societyId, _id: { $in: ids } }).lean();

// Decides what the gate should do with a vehicle. Order: blocklist > registered > visitor inside > unknown.
export async function evaluate(societyId, { plate, tag, direction }, now = new Date()) {
  const number = normalizePlate(plate);
  const tagKey = tag ? String(tag).trim().toUpperCase() : null;
  let vehicle = null;
  if (tagKey) vehicle = await Vehicle.findOne({ society: societyId, rfidTag: tagKey }).populate('unit', 'label').lean();
  if (!vehicle && number) vehicle = await Vehicle.findOne({ society: societyId, number }).populate('unit', 'label').lean();
  const effectivePlate = vehicle?.number || number || null;

  const hit = effectivePlate ? await watchlist.screen(societyId, { vehicleNumber: effectivePlate }, now) : { block: null, watch: null };
  if (hit.block) return { plate: effectivePlate, tag: tagKey, vehicle, match: 'blocked', decision: 'deny', reason: `Blocklisted: ${hit.block.reason}`, watchHit: hit.block };
  if (vehicle) {
    if (hit.watch) return { plate: effectivePlate, tag: tagKey, vehicle, match: 'watch', decision: 'allow', reason: `Watchlist: ${hit.watch.reason}`, watchHit: hit.watch };
    return { plate: effectivePlate, tag: tagKey, vehicle, match: 'resident', decision: 'allow', reason: `Registered to ${vehicle.unit?.label || 'a unit'}` };
  }

  // A visitor's car: logged at the gate with this number and currently inside (or approved just now).
  const visitor = effectivePlate
    ? await Visitor.findOne({ society: societyId, vehicleNumber: effectivePlate, status: 'checked_in', createdAt: { $gte: new Date(now.getTime() - 24 * 3600 * 1000) } })
        .sort({ createdAt: -1 })
        .populate('unit', 'label')
        .lean()
    : null;
  if (visitor) {
    const match = hit.watch ? 'watch' : 'visitor';
    return { plate: effectivePlate, tag: tagKey, vehicle: null, visitor, match, decision: 'allow', reason: `Visitor for ${visitor.unit?.label || 'a unit'}`, watchHit: hit.watch };
  }

  const settings = await getSettings(societyId);
  const allowOut = direction === 'out' && settings.allowUnknownExit;
  return {
    plate: effectivePlate,
    tag: tagKey,
    vehicle: null,
    match: hit.watch ? 'watch' : 'unknown',
    decision: allowOut ? 'allow' : 'deny',
    reason: tagKey && !number ? 'Unknown RFID tag' : allowOut ? 'Unregistered vehicle leaving' : 'Unregistered vehicle — guard to verify',
    watchHit: hit.watch,
  };
}

// Alerts guards / management for unknown, blocked and watch-listed vehicles (unknown plates at most every 10 min).
async function alertMovement(societyId, movement, evaluation) {
  const label = movement.plate || movement.tag || 'Unknown vehicle';
  if (evaluation.watchHit) {
    await watchlist.alertHit(societyId, evaluation.watchHit, { subject: `vehicle ${label}`, gate: movement.gate });
    return true;
  }
  if (movement.match !== 'unknown') return false;
  if (movement.plate) {
    const recent = await VehicleMovement.exists({
      society: societyId,
      plate: movement.plate,
      alerted: true,
      _id: { $ne: movement._id },
      occurredAt: { $gte: new Date(movement.occurredAt.getTime() - UNKNOWN_ALERT_COOLDOWN_MS) },
    });
    if (recent) return false;
  }
  await notifyRoles(societyId, [ROLES.GUARD, ROLES.FACILITY_MANAGER], {
    type: 'security',
    title: `Unknown vehicle at ${movement.gate}`,
    body: `${label} · ${movement.direction === 'in' ? 'entering' : 'leaving'} · ${movement.decision === 'allow' ? 'allowed' : 'held for check'}`,
    link: '/vehicle-movements?match=unknown',
    channels: ['inapp', 'push'],
  });
  return true;
}

// Writes a movement row and raises any alert. `ctx.device` is set for hardware events.
// gate: a resolved gate ({ _id, name }), or a plain name from older callers.
export async function recordMovement(ctx, { source, direction, gate, imageUrl, confidence, occurredAt, eventId, visitorId, evaluation }) {
  const now = new Date();
  const g = typeof gate === 'string' ? { name: gate } : gate || (await gateSvc.ensureDefaultGate(ctx.societyId));
  const movement = await VehicleMovement.create({
    society: ctx.societyId,
    plate: evaluation.plate || undefined,
    tag: evaluation.tag || undefined,
    direction,
    gate: g?.name || 'Main gate',
    gateId: g?._id,
    source,
    match: evaluation.match,
    decision: evaluation.decision,
    reason: evaluation.reason,
    vehicle: evaluation.vehicle?._id,
    unit: evaluation.vehicle?.unit?._id || evaluation.visitor?.unit?._id,
    visitor: visitorId || evaluation.visitor?._id,
    watchlistEntry: evaluation.watchHit?._id,
    imageUrl,
    confidence,
    occurredAt: occurredAt || now,
    device: ctx.deviceId,
    eventId,
    loggedBy: ctx.userId || undefined,
  });
  if (await alertMovement(ctx.societyId, movement, evaluation)) await VehicleMovement.updateOne({ _id: movement._id }, { alerted: true });
  invalidate(ctx.societyId, ['vehicleMovements'], { roles: [ROLES.GUARD] });
  return movement.toObject();
}

// Guard types a plate at the gate (no camera). Returns the decision so the console can show it.
// A gate that takes no vehicles (pedestrian / service-only) refuses the log.
export async function logManual(ctx, { plate, direction, gate, gateId, note }) {
  const g = await gateSvc.resolveGate(ctx, gateId || gate, { freeText: true });
  await gateSvc.checkKind(ctx, g, 'vehicles');
  const evaluation = await evaluate(ctx.societyId, { plate, direction });
  const movement = await recordMovement(ctx, { source: 'manual', direction, gate: g, evaluation });
  if (note) await VehicleMovement.updateOne({ _id: movement._id }, { reason: `${evaluation.reason} · ${note}` });
  return { ...(await VehicleMovement.findById(movement._id).populate(MOVEMENT_POPULATE).lean()), vehicleInfo: evaluation.vehicle };
}

// Visitor entries with a vehicle are logged as movements (no unknown-vehicle alert: the guard is with them).
export async function logVisitorVehicle(ctx, visitor) {
  if (!visitor.vehicleNumber) return;
  const vehicle = await findByPlate(ctx.societyId, visitor.vehicleNumber);
  const evaluation = {
    plate: normalizePlate(visitor.vehicleNumber),
    vehicle,
    match: visitor.flag?.type === 'block' ? 'blocked' : visitor.flag?.type === 'watch' ? 'watch' : vehicle ? 'resident' : 'visitor',
    decision: visitor.status === 'denied' ? 'deny' : 'allow',
    reason: `Visitor ${visitor.name}`,
  };
  const gate = visitor.entryGateName ? { _id: visitor.entryGate, name: visitor.entryGateName } : undefined;
  await recordMovement(ctx, { source: 'visitor', direction: 'in', gate, occurredAt: visitor.occurredAt || visitor.createdAt, visitorId: visitor._id, evaluation }).catch(() => {});
}

export async function listMovements(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  if (filters.match) filter.match = filters.match;
  if (filters.direction) filter.direction = filters.direction;
  if (filters.source) filter.source = filters.source;
  // By gate id or name; movements from before gates were set up match on the name.
  if (filters.gate) Object.assign(filter, gateSvc.legacyGateFilter(await gateSvc.resolveGate(ctx, filters.gate, { freeText: true, includeInactive: true })));
  if (filters.plate) filter.plate = { $regex: escapeRegex(normalizePlate(filters.plate)) };
  if (filters.from || filters.to) {
    filter.occurredAt = {};
    if (filters.from) filter.occurredAt.$gte = filters.from;
    if (filters.to) filter.occurredAt.$lt = filters.to;
  }
  return paginate(VehicleMovement, filter, pagination, { sort: { occurredAt: -1 }, populate: MOVEMENT_POPULATE });
}

// Parking allotment keeps the vehicle's slot label in sync for gate screens and the resident's list.
export async function setParkingSlot(societyId, vehicleIds, slotNumber) {
  if (!vehicleIds.length) return;
  await Vehicle.updateMany({ society: societyId, _id: { $in: vehicleIds } }, slotNumber ? { parkingSlot: slotNumber } : { $unset: { parkingSlot: 1 } });
}
