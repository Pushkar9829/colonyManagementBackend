import GateSyncOp from './gateSyncOp.model.js';
import Visitor from './visitor.model.js';
import ApiError from '../../common/errors/ApiError.js';
import logger from '../../common/utils/logger.js';
import * as visitors from './visitors.service.js';
import * as dailyHelp from '../dailyHelp/dailyHelp.service.js';
import * as schema from './visitors.validation.js';
import { isObjectId } from '../../common/utils/schemas.js';

const brief = (v) => v && { _id: v._id, name: v.name, status: v.status, unit: v.unit, checkInAt: v.checkInAt, checkOutAt: v.checkOutAt, occurredAt: v.occurredAt, entryGateName: v.entryGateName, exitGateName: v.exitGateName };

function parse(zodSchema, data) {
  const r = zodSchema.safeParse(data);
  if (!r.success) throw ApiError.badRequest(r.error.issues.map((i) => `${i.path.join('.') || 'data'}: ${i.message}`).join('; '));
  return r.data;
}

// The gate the guard was at when it happened (queued with the op), not wherever they are at sync time.
const gateOf = (op, data) => data.gateId || op.gateId;
// For the claim row: op.data is not validated yet, so only a well-formed id is kept.
const validGate = (op) => [op.gateId, op.data?.gateId].find((g) => typeof g === 'string' && isObjectId(g));

async function apply(ctx, op) {
  switch (op.kind) {
    case 'entry': {
      const data = parse(schema.syncEntry, op.data);
      const v = await visitors.logEntry(ctx, { ...data, gateId: gateOf(op, data), clientKey: op.key, occurredAt: op.occurredAt });
      return { ref: v._id, result: { visitor: brief(v), leaveAtGate: v.leaveAtGate || false, watch: v.watch } };
    }
    case 'checkout': {
      const data = parse(schema.syncCheckout, op.data);
      let id = data.visitorId;
      if (!id) {
        // Entry made offline too: find it by the key it was synced with (it must be earlier in this batch or a previous one).
        const entry = await Visitor.findOne({ society: ctx.societyId, clientKey: data.entryKey }).select('_id').lean();
        if (!entry) throw ApiError.conflict('The matching entry was not synced (it may have been refused)');
        id = entry._id;
      }
      const v = await visitors.checkOut(ctx, id, { occurredAt: op.occurredAt, gateId: gateOf(op, data) });
      return { ref: v._id, result: { visitor: brief(v) } };
    }
    case 'pass': {
      const data = parse(schema.syncPass, op.data);
      const v = await visitors.verifyPass(ctx, data.code, { qr: data.qr, occurredAt: op.occurredAt, clientKey: op.key, gateId: gateOf(op, data), guardApproved: data.guardApproved });
      return { ref: v._id, result: { visitor: brief(v), watch: v.watch } };
    }
    case 'help_scan': {
      const data = parse(schema.syncHelp, op.data);
      // Attendance keeps the time the guard scanned offline, not the sync time.
      const r = await dailyHelp.gateScan(ctx, data.passcode, { occurredAt: op.occurredAt || data.occurredAt, gateId: gateOf(op, data) });
      return { ref: r.help._id, result: { direction: r.direction, help: { _id: r.help._id, name: r.help.name } } };
    }
    default:
      throw ApiError.badRequest('Unknown action');
  }
}

// Replays a guard's offline queue in order. Each op is claimed by inserting its key first, so a retry
// (or two tabs syncing at once) never applies it twice; the stored outcome is returned instead.
// Business refusals (blocklist, already checked out, pass used) are kept as permanent conflicts;
// unexpected failures release the key so the next sync can retry.
export async function sync(ctx, ops) {
  const results = [];
  for (const op of ops) {
    let claim;
    try {
      // eslint-disable-next-line no-await-in-loop
      claim = await GateSyncOp.create({ society: ctx.societyId, key: op.key, kind: op.kind, occurredAt: op.occurredAt, gate: validGate(op), syncedBy: ctx.userId });
    } catch (err) {
      if (err.code !== 11000) throw err;
      // eslint-disable-next-line no-await-in-loop
      const prev = await GateSyncOp.findOne({ society: ctx.societyId, key: op.key }).lean();
      results.push({ key: op.key, kind: op.kind, status: prev.status === 'processing' ? 'processing' : prev.status, duplicate: true, message: prev.message, result: prev.result });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const { ref, result, message } = await apply(ctx, op);
      // eslint-disable-next-line no-await-in-loop
      await GateSyncOp.updateOne({ _id: claim._id }, { status: 'ok', ref, result, message });
      results.push({ key: op.key, kind: op.kind, status: 'ok', result, message });
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        // eslint-disable-next-line no-await-in-loop
        await GateSyncOp.updateOne({ _id: claim._id }, { status: 'conflict', message: err.message, result: { code: err.code } });
        results.push({ key: op.key, kind: op.kind, status: 'conflict', code: err.code, message: err.message });
      } else {
        logger.error({ err, key: op.key }, 'offline gate sync failed');
        // eslint-disable-next-line no-await-in-loop
        await GateSyncOp.deleteOne({ _id: claim._id });
        results.push({ key: op.key, kind: op.kind, status: 'error', message: 'Server error — will retry' });
      }
    }
  }
  return {
    results,
    summary: {
      ok: results.filter((r) => r.status === 'ok').length,
      duplicates: results.filter((r) => r.duplicate).length,
      conflicts: results.filter((r) => r.status === 'conflict').length,
      errors: results.filter((r) => r.status === 'error').length,
    },
  };
}
