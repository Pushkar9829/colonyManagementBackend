import mongoose from 'mongoose';
import { Gate, GatePost, KIND_FLAG, normalizeGateName } from './gate.model.js';
import Visitor from '../visitors/visitor.model.js';
import GuestPass from '../visitors/guestPass.model.js';
import VehicleMovement from '../vehicles/vehicleMovement.model.js';
import BarrierCommand from '../gateDevices/barrierCommand.model.js';
import DailyHelp from '../dailyHelp/dailyHelp.model.js';
import HelpAttendance from '../dailyHelp/helpAttendance.model.js';
import Parcel from '../parcels/parcel.model.js';
import DeviceKey from '../devices/deviceKey.model.js';
import { ChildAlert } from '../emergency/emergency.model.js';
import { Handover } from '../guardDuty/guardDuty.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import * as audit from '../audit/audit.service.js';
import { invalidate } from '../../realtime/socket.js';

const DEFAULT_GATE = { name: 'Main gate', code: 'MAIN', allowVisitors: true, allowVehicles: true, allowStaff: true, allowDeliveries: true, isPedestrianOnly: false, order: 0 };
// A post older than a long shift is treated as stale: the guard has gone home.
const POST_TTL_MS = 16 * 3600000;
const KIND_WORDS = { visitors: 'visitors', vehicles: 'vehicles', staff: 'daily help or staff', deliveries: 'deliveries' };
const SORT = { order: 1, name: 1 };

const isId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const refresh = (societyId) => invalidate(societyId, ['gates'], { roles: [ROLES.GUARD] });
export const brief = (g) => g && { _id: g._id, name: g.name, code: g.code };
const joinOr = (names) => (names.length <= 1 ? names[0] || '' : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`);

// ---------- default gate ----------
// Every society has at least one gate. Societies created before gates existed get "Main gate" on first use.
export async function ensureDefaultGate(societyId) {
  const first = await Gate.findOne({ society: societyId, active: true }).sort(SORT).lean();
  if (first) return first;
  const any = await Gate.findOne({ society: societyId }).sort(SORT).lean();
  if (any) return any;
  try {
    return await Gate.findOneAndUpdate(
      { society: societyId, nameKey: normalizeGateName(DEFAULT_GATE.name) },
      { $setOnInsert: { ...DEFAULT_GATE, society: societyId, nameKey: normalizeGateName(DEFAULT_GATE.name), active: true } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  } catch (err) {
    // Two first requests at once: the other one created it.
    if (err.code === 11000) return Gate.findOne({ society: societyId }).sort(SORT).lean();
    throw err;
  }
}

export async function listActive(societyId) {
  await ensureDefaultGate(societyId);
  return Gate.find({ society: societyId, active: true }).sort(SORT).lean();
}

// ---------- the guard's current gate ----------
export async function currentPost(ctx) {
  if (!ctx.userId) return null;
  const post = await GatePost.findOne({ society: ctx.societyId, guard: ctx.userId, since: { $gte: new Date(Date.now() - POST_TTL_MS) } }).lean();
  if (!post) return null;
  const gate = await Gate.findOne({ _id: post.gate, society: ctx.societyId, active: true }).lean();
  return gate ? { gate, since: post.since, source: post.source } : null;
}

export async function setPost(ctx, gateId, source = 'console') {
  const gate = await Gate.findOne({ _id: gateId, society: ctx.societyId }).lean();
  if (!gate) throw ApiError.badRequest('Unknown gate');
  if (!gate.active) throw ApiError.badRequest('{gate} is closed', { params: { gate: gate.name } });
  const since = new Date();
  await GatePost.updateOne({ society: ctx.societyId, guard: ctx.userId }, { gate: gate._id, gateName: gate.name, since, source }, { upsert: true });
  return { gate, since, source };
}

export async function myPost(ctx) {
  const post = await currentPost(ctx);
  return post ? { gate: post.gate, since: post.since, source: post.source } : { gate: null };
}

// ---------- resolving the gate of a request ----------
// ref: a gate id, or (legacy clients and devices) a gate name or code. Nothing given → the guard's
// current gate → the society's first gate. An id from another society is refused.
// freeText: legacy string-gate records (vehicle movements, barrier commands, child alerts) keep an
// unknown name as given instead of failing; the result then has no _id.
// includeInactive: for filters over history, where a closed gate is still a valid choice.
export async function resolveGate(ctx, ref, { freeText = false, includeInactive = false } = {}) {
  const value = typeof ref === 'string' ? ref.trim() : ref ? String(ref) : '';
  if (value) {
    if (isId(value)) {
      const gate = await Gate.findOne({ _id: value, society: ctx.societyId }).lean();
      if (!gate) throw ApiError.badRequest('Unknown gate');
      if (!gate.active && !includeInactive) throw ApiError.badRequest('{gate} is closed — pick another gate', { params: { gate: gate.name } });
      return gate;
    }
    await ensureDefaultGate(ctx.societyId);
    const gate = await Gate.findOne({ society: ctx.societyId, $or: [{ nameKey: normalizeGateName(value) }, { code: value.toUpperCase() }] }).lean();
    if (gate) return gate;
    if (freeText) return { _id: undefined, name: value };
    throw ApiError.badRequest('Unknown gate "{gate}"', { params: { gate: value } });
  }
  if (ctx.role === ROLES.GUARD) {
    const post = await currentPost(ctx);
    if (post) return post.gate;
  }
  return ensureDefaultGate(ctx.societyId);
}

// Validates a list of gate ids from a client (pass gates, helper's allowed gates). Empty = any gate.
export async function assertGateIds(societyId, ids = []) {
  const unique = [...new Set(ids.map(String))];
  if (!unique.length) return [];
  const count = await Gate.countDocuments({ society: societyId, _id: { $in: unique }, active: true });
  if (count !== unique.length) throw ApiError.badRequest('One or more gates are invalid or closed');
  return unique;
}

const refuse = ({ template, params }) => new ApiError(403, 'GATE_NOT_ALLOWED', template, { params });
const filled = ({ template, params }) => template.replace(/\{(\w+)\}/g, (_, k) => params[k]);

async function alternatives(societyId, kind, exclude) {
  const flag = KIND_FLAG[kind];
  const filter = { society: societyId, active: true, _id: { $ne: exclude }, [flag]: true };
  if (kind === 'vehicles') filter.isPedestrianOnly = { $ne: true };
  const gates = await Gate.find(filter).sort(SORT).select('name').limit(3).lean();
  return gates.map((g) => g.name);
}

// Checks the gate's kind flags. Returns { override } when the guard overrode a refusal, null when allowed.
//   kind: visitors | vehicles | staff | deliveries;  withVehicle: a visitor arriving in a vehicle
export async function checkKind(ctx, gate, kind, { withVehicle = false, override = false } = {}) {
  if (!gate?._id) return null; // free-text legacy gate: no rules known
  let message = null;
  if (!gate[KIND_FLAG[kind]] || (kind === 'vehicles' && gate.isPedestrianOnly)) {
    const alt = await alternatives(ctx.societyId, kind, gate._id);
    message = { template: `{gate} does not take ${KIND_WORDS[kind]}${alt.length ? ' — use {alt}' : ''}`, params: { gate: gate.name, alt: joinOr(alt) } };
  } else if (withVehicle && gate.isPedestrianOnly) {
    const alt = await alternatives(ctx.societyId, 'vehicles', gate._id);
    message = { template: `{gate} is for people on foot only${alt.length ? ' — vehicles use {alt}' : ''}`, params: { gate: gate.name, alt: joinOr(alt) } };
  }
  if (!message) return null;
  if (override) return { override: overrideRecord(ctx, filled(message)) };
  throw refuse(message);
}

// A pass / helper limited to some gates. Empty list = any gate.
//   name: whose permission it is (a helper's name); without it the message talks about "this pass".
export async function checkListed(ctx, gate, allowedIds, { name, override = false } = {}) {
  if (!allowedIds?.length || !gate?._id) return null;
  if (allowedIds.some((id) => String(id) === String(gate._id))) return null;
  const gates = await Gate.find({ society: ctx.societyId, _id: { $in: allowedIds } }).sort(SORT).select('name').lean();
  const names = joinOr(gates.map((g) => g.name));
  const message = { template: `${name ? '{name} is' : 'This pass is'} only valid at ${names ? '{gates}' : 'another gate'}`, params: { name, gates: names } };
  if (override) return { override: overrideRecord(ctx, filled(message)) };
  throw refuse(message);
}

const overrideRecord = (ctx, reason) => ({ at: new Date(), by: ctx.userId, reason });

// Filter for records that keep the gate as a name string (and, since multi-gate, also a gateId):
// old documents only have the name.
export function legacyGateFilter(gate) {
  if (!gate?._id) return { gate: gate?.name };
  return { $or: [{ gateId: gate._id }, { gateId: null, gate: gate.name }] };
}

// ---------- management ----------
export async function list(ctx, { includeInactive } = {}) {
  await ensureDefaultGate(ctx.societyId);
  const manager = [ROLES.ADMIN, ROLES.FACILITY_MANAGER].includes(ctx.role);
  // Only management sees closed gates; guards and residents pick from open ones.
  const filter = { society: ctx.societyId };
  if (!(manager && includeInactive)) filter.active = true;
  return Gate.find(filter).sort(SORT).lean();
}

async function uniqueCode(societyId, wanted, name, excludeId) {
  const base = (wanted || name.replace(/gate/i, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 5) || 'GATE').toUpperCase().slice(0, 8);
  if (wanted) {
    const taken = await Gate.exists({ society: societyId, code: base, _id: { $ne: excludeId } });
    if (taken) throw ApiError.conflict('Another gate already uses the code {code}', { params: { code: base } });
    return base;
  }
  for (let i = 0; i < 50; i += 1) {
    const code = i ? `${base.slice(0, 6)}${i + 1}` : base;
    // eslint-disable-next-line no-await-in-loop
    if (!(await Gate.exists({ society: societyId, code, _id: { $ne: excludeId } }))) return code;
  }
  throw ApiError.conflict('Could not pick a gate code — enter one');
}

function duplicate(err) {
  if (err.code !== 11000) return err;
  return ApiError.conflict(err.keyPattern?.code ? 'Another gate already uses this code' : 'A gate with this name already exists');
}

export async function create(ctx, data) {
  await ensureDefaultGate(ctx.societyId);
  if (await Gate.exists({ society: ctx.societyId, nameKey: normalizeGateName(data.name) })) throw ApiError.conflict('A gate with this name already exists');
  const code = await uniqueCode(ctx.societyId, data.code, data.name);
  const last = await Gate.findOne({ society: ctx.societyId }).sort({ order: -1 }).select('order').lean();
  try {
    const gate = await Gate.create({ ...data, code, order: data.order ?? (last ? last.order + 1 : 0), society: ctx.societyId, createdBy: ctx.userId });
    audit.record(ctx, 'gate.created', 'Gate', gate._id, { name: gate.name });
    refresh(ctx.societyId);
    return gate.toObject();
  } catch (err) {
    throw duplicate(err);
  }
}

async function assertAnotherActive(ctx, gate) {
  const others = await Gate.countDocuments({ society: ctx.societyId, active: true, _id: { $ne: gate._id } });
  if (!others) throw ApiError.conflict('The society needs at least one open gate');
}

export async function update(ctx, id, data) {
  const gate = await Gate.findOne({ _id: id, society: ctx.societyId });
  if (!gate) throw ApiError.notFound('Gate not found');
  if (data.active === false && gate.active) await assertAnotherActive(ctx, gate);
  if (data.name && normalizeGateName(data.name) !== gate.nameKey && (await Gate.exists({ society: ctx.societyId, nameKey: normalizeGateName(data.name), _id: { $ne: gate._id } }))) {
    throw ApiError.conflict('A gate with this name already exists');
  }
  if (data.code && data.code.toUpperCase() !== gate.code) data.code = await uniqueCode(ctx.societyId, data.code, gate.name, gate._id);
  Object.assign(gate, data);
  if (!Object.values(KIND_FLAG).some((f) => gate[f])) throw ApiError.validation([{ field: 'body.allowVisitors', message: 'A gate must take at least one kind of entry' }]);
  try {
    await gate.save();
  } catch (err) {
    throw duplicate(err);
  }
  audit.record(ctx, 'gate.updated', 'Gate', gate._id, data);
  refresh(ctx.societyId);
  return gate.toObject();
}

export async function reorder(ctx, ids) {
  const gates = await Gate.find({ society: ctx.societyId, _id: { $in: ids } }).select('_id').lean();
  if (gates.length !== new Set(ids.map(String)).size) throw ApiError.badRequest('One or more gates are invalid');
  await Gate.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id, society: ctx.societyId }, update: { order } } })));
  refresh(ctx.societyId);
  return list(ctx, { includeInactive: true });
}

// Is the gate referenced by any record? Used gates are deactivated instead of deleted, so history keeps its gate.
async function inUse(societyId, gateId) {
  const id = new mongoose.Types.ObjectId(String(gateId));
  const checks = [
    Visitor.exists({ society: societyId, $or: [{ entryGate: id }, { exitGate: id }] }),
    GuestPass.exists({ society: societyId, gates: id }),
    VehicleMovement.exists({ society: societyId, gateId: id }),
    BarrierCommand.exists({ society: societyId, gateId: id }),
    DailyHelp.exists({ society: societyId, $or: [{ allowedGates: id }, { lastGate: id }] }),
    HelpAttendance.exists({ society: societyId, $or: [{ inGate: id }, { outGate: id }] }),
    Parcel.exists({ society: societyId, gate: id }),
    DeviceKey.exists({ society: societyId, gate: id }),
    ChildAlert.exists({ society: societyId, gateId: id }),
    Handover.exists({ society: societyId, gateId: id }),
  ];
  return (await Promise.all(checks)).some(Boolean);
}

export async function remove(ctx, id) {
  const gate = await Gate.findOne({ _id: id, society: ctx.societyId });
  if (!gate) throw ApiError.notFound('Gate not found');
  if (gate.active) await assertAnotherActive(ctx, gate);
  if (await inUse(ctx.societyId, gate._id)) {
    gate.active = false;
    await gate.save();
    audit.record(ctx, 'gate.deactivated', 'Gate', gate._id, { name: gate.name });
    refresh(ctx.societyId);
    return { deleted: false, gate: gate.toObject() };
  }
  await gate.deleteOne();
  await GatePost.deleteMany({ society: ctx.societyId, gate: gate._id });
  audit.record(ctx, 'gate.deleted', 'Gate', gate._id, { name: gate.name });
  refresh(ctx.societyId);
  return { deleted: true, gate: gate.toObject() };
}
