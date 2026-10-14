import crypto from 'node:crypto';
import DeviceKey from './deviceKey.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { sha256 } from '../../common/utils/codes.js';
import * as audit from '../audit/audit.service.js';
import * as gateSvc from '../gates/gates.service.js';

const PUBLIC = 'name type location scopes prefix active lastUsedAt createdAt gate';
const GATE_POPULATE = { path: 'gate', select: 'name code active' };

export const list = (ctx) => DeviceKey.find({ society: ctx.societyId }).select(PUBLIC).populate(GATE_POPULATE).sort({ createdAt: -1 }).lean();

// gateId → the device's gate (must be one of this society's open gates); null unlinks.
async function withGate(ctx, { gateId, ...data }) {
  if (gateId === undefined) return { set: data };
  if (gateId === null) return { set: data, unset: { gate: 1 } };
  const [id] = await gateSvc.assertGateIds(ctx.societyId, [gateId]);
  return { set: { ...data, gate: id } };
}

// Returns the plain key exactly once.
export async function create(ctx, body) {
  const { set } = await withGate(ctx, body);
  const key = `chk_${crypto.randomBytes(24).toString('base64url')}`;
  const doc = await DeviceKey.create({ ...set, society: ctx.societyId, createdBy: ctx.userId, prefix: key.slice(0, 10), keyHash: sha256(key) });
  audit.record(ctx, 'device.key_created', 'DeviceKey', doc._id, { name: doc.name, scopes: doc.scopes, gate: doc.gate });
  return { _id: doc._id, name: doc.name, type: doc.type, scopes: doc.scopes, prefix: doc.prefix, gate: doc.gate || null, key };
}

export async function update(ctx, id, body) {
  const { set, unset } = await withGate(ctx, body);
  const doc = await DeviceKey.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: set, ...(unset ? { $unset: unset } : {}) }, { returnDocument: 'after' })
    .select(PUBLIC)
    .populate(GATE_POPULATE)
    .lean();
  if (!doc) throw ApiError.notFound('Device not found');
  audit.record(ctx, 'device.key_updated', 'DeviceKey', id, body);
  return doc;
}

export async function revoke(ctx, id) {
  const res = await DeviceKey.deleteOne({ _id: id, society: ctx.societyId });
  if (!res.deletedCount) throw ApiError.notFound('Device not found');
  audit.record(ctx, 'device.key_revoked', 'DeviceKey', id);
}

// Used by the device middleware.
export async function findActiveByKey(key) {
  if (!key || !key.startsWith('chk_')) return null;
  const doc = await DeviceKey.findOne({ keyHash: sha256(key), active: true }).lean();
  if (doc) DeviceKey.updateOne({ _id: doc._id }, { lastUsedAt: new Date() }).catch(() => {});
  return doc;
}
