import mongoose from 'mongoose';
import { Checkpoint, PatrolRound, PatrolRoute, PatrolScan } from './patrol.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { randomCode } from '../../common/utils/codes.js';
import { addDays, localDateString } from '../../common/utils/dates.js';
import { ROLES } from '../../common/constants/index.js';
import * as audit from '../audit/audit.service.js';
import { getSettings } from '../visitors/securitySettings.service.js';
import { eventTime, localDateTime, localParts } from '../visitors/gateTime.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';

const MIN = 60000;
const QR_PREFIX = 'CHKPT:';
export const checkpointQr = (cp) => `${QR_PREFIX}${cp.code}`;
const refresh = (societyId) => invalidate(societyId, ['patrols'], { roles: [ROLES.GUARD] });

// ---------- schedule maths ----------
// Rounds of `route` whose window overlaps [from, to). Each round starts at startTime + k * frequency
// and lasts one frequency (the last one is cut at the window end).
export function slotsFor(route, from, to) {
  const slots = [];
  const freq = route.frequencyMinutes * MIN;
  for (let d = addDays(from, -1); d < addDays(to, 1); d = addDays(d, 1)) {
    const date = localDateString(d);
    const dow = localParts(localDateTime(date, '12:00')).dow;
    if (route.days?.length && !route.days.includes(dow)) continue;
    const start = localDateTime(date, route.startTime);
    let end = localDateTime(date, route.endTime);
    if (end <= start) end = new Date(end.getTime() + 86400000);
    for (let t = start.getTime(); t < end.getTime(); t += freq) {
      const slot = { dueAt: new Date(t), windowEnd: new Date(Math.min(t + freq, end.getTime())) };
      if (slot.windowEnd > from && slot.dueAt < to) slots.push(slot);
    }
  }
  // Dates can repeat around DST-free IST boundaries when `from` is mid-day; keep unique starts.
  const seen = new Set();
  return slots.filter((s) => (seen.has(+s.dueAt) ? false : seen.add(+s.dueAt))).sort((a, b) => a.dueAt - b.dueAt);
}

// The round a scan at `at` belongs to: the one running now, else one that just ended (within grace).
function slotAt(route, at, graceMs) {
  const slots = slotsFor(route, new Date(at.getTime() - 86400000), new Date(at.getTime() + MIN));
  return slots.find((s) => s.dueAt <= at && at < s.windowEnd) || slots.find((s) => s.windowEnd <= at && at < s.windowEnd.getTime() + graceMs) || null;
}

const toRad = (x) => (x * Math.PI) / 180;
function distanceM(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// ---------- checkpoints ----------
export async function listCheckpoints(ctx, { active }) {
  const filter = { society: ctx.societyId };
  if (active !== undefined) filter.active = active;
  const items = await Checkpoint.find(filter).sort({ name: 1 }).lean();
  return items.map((c) => ({ ...c, qr: checkpointQr(c) }));
}

export async function createCheckpoint(ctx, data) {
  for (let i = 0; i < 5; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const cp = await Checkpoint.create({ ...data, society: ctx.societyId, code: randomCode(10) });
      audit.record(ctx, 'patrol.checkpoint_created', 'PatrolCheckpoint', cp._id, { name: cp.name });
      return { ...cp.toObject(), qr: checkpointQr(cp) };
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  throw new Error('Could not generate a checkpoint code');
}

export async function updateCheckpoint(ctx, id, { regenerateCode, ...data }) {
  const cp = await Checkpoint.findOne({ _id: id, society: ctx.societyId });
  if (!cp) throw ApiError.notFound('Checkpoint not found');
  Object.assign(cp, data);
  // A lost or photographed QR can be replaced; the old print stops working.
  if (regenerateCode) cp.code = randomCode(10);
  await cp.save();
  return { ...cp.toObject(), qr: checkpointQr(cp) };
}

export async function removeCheckpoint(ctx, id) {
  if (await PatrolRoute.exists({ society: ctx.societyId, checkpoints: id, active: true })) {
    throw ApiError.conflict('This checkpoint is on an active route. Remove it from the route or deactivate it instead.');
  }
  const res = await Checkpoint.deleteOne({ _id: id, society: ctx.societyId });
  if (!res.deletedCount) throw ApiError.notFound('Checkpoint not found');
  audit.record(ctx, 'patrol.checkpoint_removed', 'PatrolCheckpoint', id);
}

// ---------- routes ----------
const ROUTE_POPULATE = { path: 'checkpoints', select: 'name location active' };

async function assertCheckpoints(ctx, ids) {
  const unique = [...new Set(ids.map(String))];
  if (unique.length !== ids.length) throw ApiError.badRequest('A checkpoint appears twice on the route');
  const n = await Checkpoint.countDocuments({ society: ctx.societyId, _id: { $in: unique } });
  if (n !== unique.length) throw ApiError.badRequest('One or more checkpoints are invalid');
}

export const listRoutes = (ctx) => PatrolRoute.find({ society: ctx.societyId }).sort({ active: -1, name: 1 }).populate(ROUTE_POPULATE).lean();

export async function createRoute(ctx, data) {
  await assertCheckpoints(ctx, data.checkpoints);
  const route = await PatrolRoute.create({ ...data, society: ctx.societyId, createdBy: ctx.userId });
  audit.record(ctx, 'patrol.route_created', 'PatrolRoute', route._id, { name: route.name });
  refresh(ctx.societyId);
  return PatrolRoute.findById(route._id).populate(ROUTE_POPULATE).lean();
}

export async function updateRoute(ctx, id, data) {
  if (data.checkpoints) await assertCheckpoints(ctx, data.checkpoints);
  const route = await PatrolRoute.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: data }, { returnDocument: 'after' }).populate(ROUTE_POPULATE).lean();
  if (!route) throw ApiError.notFound('Route not found');
  audit.record(ctx, 'patrol.route_updated', 'PatrolRoute', id, data);
  refresh(ctx.societyId);
  return route;
}

export async function removeRoute(ctx, id) {
  const res = await PatrolRoute.deleteOne({ _id: id, society: ctx.societyId });
  if (!res.deletedCount) throw ApiError.notFound('Route not found');
  audit.record(ctx, 'patrol.route_removed', 'PatrolRoute', id);
  refresh(ctx.societyId);
}

// ---------- scanning ----------
function parseCode(raw) {
  const v = raw.trim();
  return v.startsWith(QR_PREFIX) ? v.slice(QR_PREFIX.length) : v;
}

export async function scan(ctx, { code, lat, lng, accuracyM, occurredAt, note }) {
  const at = eventTime(occurredAt);
  if (!at) throw ApiError.badRequest('This scan is too old to record');
  const cp = await Checkpoint.findOne({ society: ctx.societyId, code: parseCode(code) }).lean();
  if (!cp) throw ApiError.notFound('Unknown checkpoint QR');
  if (!cp.active) throw ApiError.badRequest('{name} is not in use', { params: { name: cp.name } });

  let gpsOk = null;
  let dist;
  if (cp.lat != null && cp.lng != null && lat != null && lng != null) {
    dist = distanceM(cp, { lat, lng });
    gpsOk = dist <= cp.radiusM + Math.min(accuracyM || 0, 100);
  }

  const { patrolGraceMinutes } = await getSettings(ctx.societyId);
  const routes = await PatrolRoute.find({ society: ctx.societyId, active: true, checkpoints: cp._id }).lean();
  const touched = [];
  for (const route of routes) {
    const slot = slotAt(route, at, patrolGraceMinutes * MIN);
    if (!slot) continue;
    // eslint-disable-next-line no-await-in-loop
    const round = await PatrolRound.findOneAndUpdate(
      { route: route._id, dueAt: slot.dueAt },
      { $setOnInsert: { society: ctx.societyId, windowEnd: slot.windowEnd, expected: route.checkpoints.length } },
      { upsert: true, returnDocument: 'after' },
    );
    if (['completed', 'missed', 'partial'].includes(round.status) && round.alertedAt) {
      touched.push({ round, route, already: false, closed: true });
      continue;
    }
    const done = new Set(round.scans.map((s) => String(s.checkpoint)));
    if (done.has(String(cp._id))) {
      touched.push({ round, route, already: true });
      continue;
    }
    const expectedNext = route.checkpoints.find((c) => !done.has(String(c)));
    const inOrder = round.inOrder && (!expectedNext || String(expectedNext) === String(cp._id));
    if (route.enforceOrder && !inOrder) {
      // eslint-disable-next-line no-await-in-loop
      const next = await Checkpoint.findById(expectedNext).select('name').lean();
      throw ApiError.conflict('Scan {checkpoint} first — this route must be walked in order', { params: { checkpoint: next?.name || 'the next checkpoint' } });
    }
    const scansCount = done.size + 1;
    const complete = route.checkpoints.every((c) => done.has(String(c)) || String(c) === String(cp._id));
    // eslint-disable-next-line no-await-in-loop
    const updated = await PatrolRound.findOneAndUpdate(
      { _id: round._id, 'scans.checkpoint': { $ne: cp._id } },
      {
        $push: { scans: { checkpoint: cp._id, scannedAt: at, guard: ctx.userId, gpsOk } },
        $set: {
          inOrder,
          status: complete ? 'completed' : 'in_progress',
          ...(complete ? { completedAt: at, missedCheckpoints: [] } : {}),
          ...(scansCount === 1 ? { startedAt: at } : {}),
        },
      },
      { returnDocument: 'after' },
    );
    touched.push({ round: updated || round, route, already: !updated });
  }

  const record = await PatrolScan.create({
    society: ctx.societyId,
    checkpoint: cp._id,
    guard: ctx.userId,
    scannedAt: at,
    lat,
    lng,
    accuracyM,
    distanceM: dist,
    gpsOk,
    note,
    rounds: touched.map((t) => t.round._id),
  });
  refresh(ctx.societyId);
  return {
    scan: { _id: record._id, scannedAt: at, gpsOk, distanceM: dist ?? null },
    checkpoint: { _id: cp._id, name: cp.name, location: cp.location },
    rounds: touched.map(({ round, route, already, closed }) => ({
      _id: round._id,
      route: { _id: route._id, name: route.name },
      dueAt: round.dueAt,
      windowEnd: round.windowEnd,
      status: round.status,
      scanned: round.scans.length,
      expected: route.checkpoints.length,
      alreadyScanned: Boolean(already),
      closed: Boolean(closed),
    })),
  };
}

// Guard view: each active route's current round with checkpoint ticks, plus when the next round starts.
export async function current(ctx, now = new Date()) {
  const { patrolGraceMinutes } = await getSettings(ctx.societyId);
  const routes = await PatrolRoute.find({ society: ctx.societyId, active: true }).populate(ROUTE_POPULATE).lean();
  const out = [];
  for (const route of routes) {
    const slot = slotAt({ ...route, checkpoints: route.checkpoints.map((c) => c._id) }, now, patrolGraceMinutes * MIN);
    const next = slotsFor(route, now, addDays(now, 8)).find((s) => s.dueAt > now);
    // eslint-disable-next-line no-await-in-loop
    const round = slot ? await PatrolRound.findOne({ route: route._id, dueAt: slot.dueAt }).lean() : null;
    const done = new Map((round?.scans || []).map((s) => [String(s.checkpoint), s]));
    out.push({
      route: { _id: route._id, name: route.name, frequencyMinutes: route.frequencyMinutes, enforceOrder: route.enforceOrder },
      slot,
      nextDueAt: next?.dueAt || null,
      status: round?.status || (slot ? 'pending' : 'idle'),
      checkpoints: route.checkpoints.map((c) => ({ _id: c._id, name: c.name, location: c.location, scannedAt: done.get(String(c._id))?.scannedAt || null, gpsOk: done.get(String(c._id))?.gpsOk ?? null })),
    });
  }
  return out;
}

const ROUND_POPULATE = [
  { path: 'route', select: 'name' },
  { path: 'scans.checkpoint', select: 'name' },
  { path: 'scans.guard', select: 'name' },
  { path: 'missedCheckpoints', select: 'name' },
];

export function listRounds(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.status) filter.status = filters.status;
  if (filters.route) filter.route = filters.route;
  if (filters.from || filters.to) {
    filter.dueAt = {};
    if (filters.from) filter.dueAt.$gte = filters.from;
    if (filters.to) filter.dueAt.$lt = filters.to;
  }
  return paginate(PatrolRound, filter, pagination, { sort: { dueAt: -1 }, populate: ROUND_POPULATE });
}

export function listScans(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (ctx.role === ROLES.GUARD && filters.mine) filter.guard = ctx.userId;
  if (filters.from || filters.to) {
    filter.scannedAt = {};
    if (filters.from) filter.scannedAt.$gte = filters.from;
    if (filters.to) filter.scannedAt.$lt = filters.to;
  }
  return paginate(PatrolScan, filter, pagination, {
    sort: { scannedAt: -1 },
    populate: [
      { path: 'checkpoint', select: 'name location' },
      { path: 'guard', select: 'name' },
    ],
  });
}

// Patrol report for a period: completion per route, scans per guard, GPS mismatches, missed rounds.
export async function report(ctx, { from, to }) {
  const end = to || new Date();
  const start = from || addDays(end, -7);
  const society = new mongoose.Types.ObjectId(String(ctx.societyId));
  const [byRoute, byGuard, missed] = await Promise.all([
    PatrolRound.aggregate([
      { $match: { society, dueAt: { $gte: start, $lt: end } } },
      { $group: { _id: { route: '$route', status: '$status' }, count: { $sum: 1 } } },
      { $group: { _id: '$_id.route', statuses: { $push: { k: '$_id.status', v: '$count' } }, total: { $sum: '$count' } } },
      { $lookup: { from: PatrolRoute.collection.name, localField: '_id', foreignField: '_id', as: 'route' } },
      { $project: { total: 1, statuses: { $arrayToObject: '$statuses' }, name: { $first: '$route.name' } } },
      { $sort: { name: 1 } },
    ]),
    PatrolScan.aggregate([
      { $match: { society, scannedAt: { $gte: start, $lt: end } } },
      { $group: { _id: '$guard', scans: { $sum: 1 }, gpsMismatch: { $sum: { $cond: [{ $eq: ['$gpsOk', false] }, 1, 0] } }, lastScanAt: { $max: '$scannedAt' } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'guard' } },
      { $project: { scans: 1, gpsMismatch: 1, lastScanAt: 1, name: { $first: '$guard.name' } } },
      { $sort: { scans: -1 } },
    ]),
    PatrolRound.find({ society: ctx.societyId, dueAt: { $gte: start, $lt: end }, status: { $in: ['missed', 'partial'] } })
      .sort({ dueAt: -1 })
      .limit(200)
      .populate(ROUND_POPULATE)
      .lean(),
  ]);
  const routes = byRoute.map((r) => {
    const completed = r.statuses.completed || 0;
    const closed = completed + (r.statuses.partial || 0) + (r.statuses.missed || 0);
    return { route: r._id, name: r.name, total: r.total, ...r.statuses, completionRate: closed ? Math.round((completed / closed) * 100) : null };
  });
  return { from: start, to: end, routes, guards: byGuard.map((g) => ({ guard: g._id, name: g.name, scans: g.scans, gpsMismatch: g.gpsMismatch, lastScanAt: g.lastScanAt })), missed };
}

// ---------- scheduler ----------
// Closes rounds whose window (plus grace) has ended: completed ones stay, others become partial/missed
// and guards + management are alerted once. Looks back 24 h so a sleeping server catches up.
export async function detectMissedRounds(lookupSettings, now = new Date()) {
  const routes = await PatrolRoute.find({ active: true }).populate('checkpoints', 'name').lean();
  const settingsFor = await lookupSettings([...new Set(routes.map((r) => String(r.society)))]);
  let missed = 0;
  let partial = 0;
  for (const route of routes) {
    const grace = settingsFor(route.society).patrolGraceMinutes * MIN;
    const lookFrom = new Date(Math.max(new Date(route.createdAt).getTime(), now.getTime() - 86400000));
    const slots = slotsFor(route, new Date(lookFrom.getTime() - grace), now).filter((s) => s.windowEnd > lookFrom && s.windowEnd.getTime() + grace <= now.getTime());
    for (const slot of slots) {
      // eslint-disable-next-line no-await-in-loop
      const round = await PatrolRound.findOneAndUpdate(
        { route: route._id, dueAt: slot.dueAt },
        { $setOnInsert: { society: route.society, windowEnd: slot.windowEnd, expected: route.checkpoints.length } },
        { upsert: true, returnDocument: 'after' },
      ).lean();
      if (round.alertedAt || round.status === 'completed') continue;
      const done = new Set(round.scans.map((s) => String(s.checkpoint)));
      const missing = route.checkpoints.filter((c) => !done.has(String(c._id)));
      const status = done.size ? 'partial' : 'missed';
      // eslint-disable-next-line no-await-in-loop
      const claimed = await PatrolRound.updateOne({ _id: round._id, alertedAt: null, status: { $ne: 'completed' } }, { status, missedCheckpoints: missing.map((c) => c._id), alertedAt: now });
      if (!claimed.modifiedCount) continue;
      if (status === 'missed') missed += 1;
      else partial += 1;
      const time = new Date(slot.dueAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
      // eslint-disable-next-line no-await-in-loop
      await notifyRoles(route.society, [ROLES.GUARD, ROLES.FACILITY_MANAGER], {
        type: 'patrol',
        title: status === 'missed' ? `Patrol missed: ${route.name} (${time})` : `Patrol incomplete: ${route.name} (${time})`,
        body: `${missing.length} checkpoint${missing.length === 1 ? '' : 's'} not scanned: ${missing.map((c) => c.name).join(', ')}`.slice(0, 280),
        link: '/patrols',
        channels: ['inapp', 'push'],
      });
      refresh(route.society);
    }
  }
  return { missed, partial };
}
