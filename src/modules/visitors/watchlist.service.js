import WatchlistEntry from './watchlist.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { ROLES } from '../../common/constants/index.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import { normalizePhone, normalizePlate } from './gateTime.js';

const POPULATE = { path: 'createdBy', select: 'name' };
const live = (now = new Date()) => ({ active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] });

const keys = (data) => ({
  nameKey: data.name ? data.name.trim().toLowerCase() : undefined,
  phoneKey: normalizePhone(data.phone) || undefined,
  vehicleNumber: normalizePlate(data.vehicleNumber) || undefined,
});

// Checks a person / vehicle against the list. Phone and vehicle numbers are strong identifiers;
// a name alone only matches entries that have no phone and no vehicle (otherwise common names
// would block innocent visitors).
export async function screen(societyId, { name, phone, vehicleNumber }, now = new Date()) {
  const { nameKey, phoneKey, vehicleNumber: plate } = keys({ name, phone, vehicleNumber });
  const or = [];
  if (phoneKey) or.push({ phoneKey });
  if (plate) or.push({ vehicleNumber: plate });
  if (nameKey) or.push({ nameKey, phoneKey: null, vehicleNumber: null });
  if (!or.length) return { block: null, watch: null, matches: [] };
  const matches = await WatchlistEntry.find({ society: societyId, ...live(now), $and: [{ $or: or }] }).lean();
  if (matches.length) {
    WatchlistEntry.updateMany({ _id: { $in: matches.map((m) => m._id) } }, { $inc: { hits: 1 }, lastHitAt: now }).catch(() => {});
  }
  return { block: matches.find((m) => m.type === 'block') || null, watch: matches.find((m) => m.type === 'watch') || null, matches };
}

// Public summary of a match for API responses (no internal ids beyond the entry id).
export const matchSummary = (m) => m && { entry: m._id, type: m.type, reason: m.reason, name: m.name, photoUrl: m.photoUrl };

// Alerts sent when the gate hits a list entry.
export async function alertHit(societyId, match, { subject, unitLabel, gate } = {}) {
  const blocked = match.type === 'block';
  await notifyRoles(societyId, blocked ? [ROLES.ADMIN, ROLES.FACILITY_MANAGER] : [ROLES.ADMIN, ROLES.FACILITY_MANAGER, ROLES.GUARD], {
    type: 'security',
    title: blocked ? `Blocked at gate: ${subject}` : `Watchlist alert: ${subject}`,
    body: `${match.reason}${unitLabel ? ` · for ${unitLabel}` : ''}${gate ? ` · ${gate}` : ''}`,
    link: '/visitors?flagged=true',
    channels: ['inapp', 'push'],
    urgent: blocked,
  });
  invalidate(societyId, ['visitors', 'watchlist']);
}

export function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.type) filter.type = filters.type;
  if (filters.active === true) Object.assign(filter, live());
  if (filters.active === false) filter.$or = [{ active: false }, { expiresAt: { $lte: new Date() } }];
  if (filters.search) {
    const rx = { $regex: escapeRegex(filters.search), $options: 'i' };
    filter.$and = [{ $or: [{ name: rx }, { phone: rx }, { vehicleNumber: { $regex: escapeRegex(normalizePlate(filters.search) || filters.search), $options: 'i' } }, { reason: rx }] }];
  }
  return paginate(WatchlistEntry, filter, pagination, { populate: POPULATE });
}

export async function create(ctx, { photo, ...data }) {
  const [file] = await uploads.resolve(ctx, photo ? [photo] : []);
  const doc = await WatchlistEntry.create({ ...data, ...keys(data), photoUrl: file?.url, society: ctx.societyId, createdBy: ctx.userId });
  audit.record(ctx, 'watchlist.created', 'WatchlistEntry', doc._id, { type: doc.type, name: doc.name, vehicleNumber: doc.vehicleNumber });
  invalidate(ctx.societyId, ['watchlist'], { roles: [ROLES.GUARD] });
  return WatchlistEntry.findById(doc._id).populate(POPULATE).lean();
}

export async function update(ctx, id, { photo, ...data }) {
  const doc = await WatchlistEntry.findOne({ _id: id, society: ctx.societyId });
  if (!doc) throw ApiError.notFound('Entry not found');
  if (photo) {
    const [file] = await uploads.resolve(ctx, [photo]);
    doc.photoUrl = file.url;
  }
  Object.assign(doc, data);
  Object.assign(doc, keys({ name: doc.name, phone: doc.phone, vehicleNumber: doc.vehicleNumber }));
  if (!doc.name && !doc.phoneKey && !doc.vehicleNumber) throw ApiError.badRequest('Give at least a name, phone or vehicle number');
  await doc.save();
  audit.record(ctx, 'watchlist.updated', 'WatchlistEntry', doc._id, data);
  invalidate(ctx.societyId, ['watchlist'], { roles: [ROLES.GUARD] });
  return WatchlistEntry.findById(doc._id).populate(POPULATE).lean();
}

export async function remove(ctx, id) {
  const doc = await WatchlistEntry.findOneAndDelete({ _id: id, society: ctx.societyId }).lean();
  if (!doc) throw ApiError.notFound('Entry not found');
  audit.record(ctx, 'watchlist.removed', 'WatchlistEntry', id, { type: doc.type, name: doc.name, vehicleNumber: doc.vehicleNumber });
  invalidate(ctx.societyId, ['watchlist'], { roles: [ROLES.GUARD] });
}

// Guard pre-check before letting someone in.
export async function check(ctx, data) {
  const { block, watch, matches } = await screen(ctx.societyId, data);
  return { status: block ? 'block' : watch ? 'watch' : 'clear', matches: matches.map(matchSummary) };
}
