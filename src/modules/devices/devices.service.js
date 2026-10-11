import crypto from 'node:crypto';
import DeviceKey from './deviceKey.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { sha256 } from '../../common/utils/codes.js';
import * as audit from '../audit/audit.service.js';

const PUBLIC = 'name type location scopes prefix active lastUsedAt createdAt';

export const list = (ctx) => DeviceKey.find({ society: ctx.societyId }).select(PUBLIC).sort({ createdAt: -1 }).lean();

// Returns the plain key exactly once.
export async function create(ctx, data) {
  const key = `chk_${crypto.randomBytes(24).toString('base64url')}`;
  const doc = await DeviceKey.create({ ...data, society: ctx.societyId, createdBy: ctx.userId, prefix: key.slice(0, 10), keyHash: sha256(key) });
  audit.record(ctx, 'device.key_created', 'DeviceKey', doc._id, { name: doc.name, scopes: doc.scopes });
  return { _id: doc._id, name: doc.name, type: doc.type, scopes: doc.scopes, prefix: doc.prefix, key };
}

export async function update(ctx, id, data) {
  const doc = await DeviceKey.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: data }, { returnDocument: 'after' }).select(PUBLIC).lean();
  if (!doc) throw ApiError.notFound('Device not found');
  audit.record(ctx, 'device.key_updated', 'DeviceKey', id, data);
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

