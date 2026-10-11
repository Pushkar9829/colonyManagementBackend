import BarrierCommand from './barrierCommand.model.js';
import VehicleMovement from '../vehicles/vehicleMovement.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { ROLES } from '../../common/constants/index.js';
import * as vehicles from '../vehicles/vehicles.service.js';
import * as audit from '../audit/audit.service.js';
import { eventTime } from '../visitors/gateTime.js';
import { invalidate } from '../../realtime/socket.js';

const COMMAND_TTL_MS = 2 * 60 * 1000;
const MOVEMENT_BRIEF = 'plate tag direction gate match decision reason occurredAt vehicle unit';

// Hardware event: an ANPR camera read a plate or an RFID reader read a tag.
// Answers with the barrier decision so the device can open (or keep closed) without a second call.
// `eventId` lets a device resend safely after a network blip.
export async function handleEvent(ctx, { type, plate, tag, direction, gate, imageUrl, confidence, occurredAt, eventId }) {
  if (eventId) {
    const prev = await VehicleMovement.findOne({ society: ctx.societyId, device: ctx.deviceId, eventId }).select(MOVEMENT_BRIEF).lean();
    if (prev) return { ...decisionOf(prev), duplicate: true };
  }
  const at = eventTime(occurredAt) || new Date();
  const evaluation = await vehicles.evaluate(ctx.societyId, { plate, tag: type === 'rfid' ? tag : undefined, direction }, at);
  let movement;
  try {
    movement = await vehicles.recordMovement(ctx, { source: type, direction, gate, imageUrl, confidence, occurredAt: at, eventId, evaluation });
  } catch (err) {
    if (err.code === 11000 && eventId) {
      const prev = await VehicleMovement.findOne({ society: ctx.societyId, device: ctx.deviceId, eventId }).select(MOVEMENT_BRIEF).lean();
      return { ...decisionOf(prev), duplicate: true };
    }
    throw err;
  }
  return {
    ...decisionOf(movement),
    vehicle: evaluation.vehicle ? { number: evaluation.vehicle.number, unit: evaluation.vehicle.unit?.label } : null,
  };
}

const decisionOf = (m) => ({
  movementId: m._id,
  decision: m.decision,
  openBarrier: m.decision === 'allow',
  match: m.match,
  reason: m.reason,
  plate: m.plate || null,
  tag: m.tag || null,
  gate: m.gate,
});

// ---- barrier command queue ----
export async function requestOpen(ctx, { gate, reason, visitorId, movementId }) {
  const cmd = await BarrierCommand.create({
    society: ctx.societyId,
    gate,
    action: 'open',
    reason,
    visitor: visitorId,
    movement: movementId,
    requestedBy: ctx.userId,
    expiresAt: new Date(Date.now() + COMMAND_TTL_MS),
  });
  audit.record(ctx, 'gate.barrier_open', 'BarrierCommand', cmd._id, { gate, reason });
  invalidate(ctx.societyId, ['barrierCommands'], { roles: [ROLES.GUARD] });
  return cmd.toObject();
}

const expireStale = (societyId) =>
  BarrierCommand.updateMany({ society: societyId, status: { $in: ['pending', 'sent'] }, expiresAt: { $lte: new Date() } }, { status: 'expired' });

// Device poll: pending (or sent but not yet acknowledged) commands for this gate, oldest first.
export async function pollCommands(ctx, { gate }) {
  await expireStale(ctx.societyId);
  const filter = { society: ctx.societyId, status: { $in: ['pending', 'sent'] } };
  if (gate) filter.gate = gate;
  const cmds = await BarrierCommand.find(filter).sort({ createdAt: 1 }).limit(20).select('gate action reason status expiresAt createdAt').lean();
  if (cmds.length) {
    await BarrierCommand.updateMany({ _id: { $in: cmds.map((c) => c._id) }, status: 'pending' }, { status: 'sent', sentAt: new Date(), sentTo: ctx.deviceId });
  }
  return cmds.map((c) => ({ _id: c._id, gate: c.gate, action: c.action, reason: c.reason, expiresAt: c.expiresAt, createdAt: c.createdAt }));
}

export async function ackCommand(ctx, id, { status, message }) {
  const cmd = await BarrierCommand.findOneAndUpdate(
    { _id: id, society: ctx.societyId, status: { $in: ['pending', 'sent'] }, expiresAt: { $gt: new Date() } },
    { status, ackedAt: new Date(), ackedBy: ctx.deviceId, ackMessage: message },
    { returnDocument: 'after' },
  ).lean();
  if (!cmd) {
    const existing = await BarrierCommand.findOne({ _id: id, society: ctx.societyId }).select('status').lean();
    if (!existing) throw ApiError.notFound('Command not found');
    if (existing.status === status) return { _id: id, status };
    throw ApiError.conflict(`Command is already ${existing.status}`);
  }
  invalidate(ctx.societyId, ['barrierCommands'], { roles: [ROLES.GUARD] });
  return { _id: cmd._id, status: cmd.status };
}

export async function listCommands(ctx, filters, pagination) {
  await expireStale(ctx.societyId);
  const filter = { society: ctx.societyId };
  if (filters.status) filter.status = filters.status;
  if (filters.gate) filter.gate = filters.gate;
  return paginate(BarrierCommand, filter, pagination, {
    populate: [
      { path: 'requestedBy', select: 'name' },
      { path: 'ackedBy', select: 'name' },
    ],
  });
}

// Gates seen in the last 30 days (for pickers on the console).
export async function gates(ctx) {
  const since = new Date(Date.now() - 30 * 86400000);
  const [fromMoves, fromCmds] = await Promise.all([
    VehicleMovement.distinct('gate', { society: ctx.societyId, occurredAt: { $gte: since } }),
    BarrierCommand.distinct('gate', { society: ctx.societyId, createdAt: { $gte: since } }),
  ]);
  return [...new Set(['Main gate', ...fromMoves, ...fromCmds].filter(Boolean))].sort();
}
