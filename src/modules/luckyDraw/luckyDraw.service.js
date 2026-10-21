import { recordPlatform } from '../platformTeam/platformAudit.js';
import mongoose from 'mongoose';
import LuckyDraw from './luckyDraw.model.js';
import LuckyDrawEntry from './luckyDrawEntry.model.js';
import Unit from '../units/unit.model.js';
import Membership from '../users/membership.model.js';
import CommitteeTerm from '../committee/committeeTerm.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import { addHours } from '../../common/utils/dates.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { nextNumber } from '../counter/counter.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { canManage, positionsOf } from '../committee/committee.service.js';
import { memberSummaries, sameId } from '../directory/members.js';
import { invalidate } from '../../realtime/socket.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { ALGORITHM, assign, entriesHash, newSeed, order, sha256 } from './fairness.js';

// Lucky draws are FREE to enter. A paid entry would turn this into a lottery, which is regulated in India
// and not something a housing society may run — so this module never takes money (see luckyDraw.model.js).

const page = (items, total, { page: p, limit }) => ({ items, meta: { page: p, limit, total, pages: Math.ceil(total / limit) || 1 } });
const link = (id) => `/lucky-draws/${id}`;
const TYPE = 'luckyDraw';
const LIVE = ['open', 'closed'];
const fmt = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const refresh = (societyId) => invalidate(societyId, ['luckyDraws']);

// ---------------- eligibility ----------------

const AUDIENCE_TEXT = {
  all_residents: 'All residents',
  owners: 'Flat owners only',
  tenants: 'Tenants only',
};

// Why the signed-in member may not enter (null = they may). Staff, guards and admin-only logins can't enter;
// residents must match the audience.
async function ineligibleReason(ctx, draw, positions) {
  if (ctx.role !== ROLES.RESIDENT) return 'Only residents can take part';
  if (!ctx.unitId) return 'Open your flat to take part';
  const type = ctx.user?.residentType;
  if (draw.eligibility?.audience === 'owners' && type !== 'owner') return 'This draw is for flat owners only';
  if (draw.eligibility?.audience === 'tenants' && type !== 'tenant') return 'This draw is for tenants only';
  if (draw.eligibility?.excludeCommittee) {
    const held = positions ?? (await positionsOf(ctx.societyId, ctx.userId));
    if (held.length) return 'Committee office-bearers cannot take part in this draw';
  }
  return null;
}

// Active resident user ids the draw is open to (for notifications).
async function eligibleUserIds(societyId, draw) {
  const filter = { society: societyId, role: ROLES.RESIDENT, status: 'active', unit: { $ne: null } };
  if (draw.eligibility?.audience === 'owners') filter.residentType = 'owner';
  if (draw.eligibility?.audience === 'tenants') filter.residentType = 'tenant';
  const members = await Membership.find(filter).select('user').lean();
  let ids = [...new Set(members.map((m) => String(m.user)))];
  if (draw.eligibility?.excludeCommittee) {
    const term = await CommitteeTerm.findOne({ society: societyId, status: 'active' }).lean();
    const committee = new Set((term?.positions || []).filter((p) => p.active).map((p) => String(p.user)));
    ids = ids.filter((id) => !committee.has(id));
  }
  return ids;
}

// ---------------- presenting ----------------

// draft | upcoming (published, entries not open yet) | open | closed (waiting for the draw) | drawn | cancelled
function phaseOf(d, now = new Date()) {
  if (d.status !== 'open') return d.status;
  if (now < new Date(d.entryOpensAt)) return 'upcoming';
  if (now < new Date(d.entryClosesAt)) return 'open';
  return 'closed';
}

function present(ctx, d, { manage, entrantCount = 0, myEntry = null, reason = null } = {}) {
  const phase = phaseOf(d);
  const drawn = d.status === 'drawn';
  const winners = (d.results || []).flatMap((r) => r.winners.filter((w) => w.status === 'won').map((w) => ({ ...w, prizeTitle: r.title })));
  const out = {
    ...d,
    phase,
    entriesOpen: phase === 'open',
    entrantCount,
    canManage: Boolean(manage),
    eligible: !reason,
    ineligibleReason: reason,
    audienceText: AUDIENCE_TEXT[d.eligibility?.audience] || AUDIENCE_TEXT.all_residents,
    totalPrizes: (d.prizes || []).reduce((s, p) => s + p.quantity, 0),
    myEntry: myEntry ? { _id: myEntry._id, status: myEntry.status, createdAt: myEntry.createdAt } : null,
    myWins: winners.filter((w) => sameId(w.user, ctx.userId)).map((w) => ({ _id: w._id, prize: w.prizeTitle, handedOverAt: w.handedOverAt })),
    fairness: {
      seedHash: d.fairness?.seedHash || null,
      seed: drawn ? d.fairness?.seed || null : null,
      algorithm: d.fairness?.algorithm || ALGORITHM,
      entriesHash: d.fairness?.entriesHash || null,
      entryCount: d.fairness?.entryCount ?? null,
    },
    results: (d.results || []).map((r) => ({
      ...r,
      winners: r.winners
        .filter((w) => manage || w.status === 'won')
        .map((w) => ({ ...w, isMe: sameId(w.user, ctx.userId), ...(manage ? {} : { handoverNote: undefined, replacedReason: undefined }) })),
    })),
  };
  if (!manage) delete out.reservesList;
  return out;
}

async function counts(societyId, drawIds) {
  const rows = await LuckyDrawEntry.aggregate([
    { $match: { society: new mongoose.Types.ObjectId(String(societyId)), draw: { $in: drawIds }, status: 'entered' } },
    { $group: { _id: '$draw', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

async function loadDraw(ctx, id, { manage, withSeed = false } = {}) {
  const filter = { _id: id, society: ctx.societyId };
  if (!manage) filter.status = { $ne: 'draft' };
  let q = LuckyDraw.findOne(filter);
  if (withSeed) q = q.select('+fairness.seed');
  const draw = await q;
  if (!draw) throw ApiError.notFound('Lucky draw not found');
  return draw;
}

// ---------------- reads ----------------

export async function list(ctx, filters, pagination) {
  const manage = await canManage(ctx);
  const filter = { society: ctx.societyId };
  if (filters.when === 'past') filter.status = { $in: ['drawn', 'cancelled'] };
  else if (filters.when === 'active') filter.status = { $in: manage ? ['draft', ...LIVE] : LIVE };
  if (filters.status) filter.status = filters.status;
  if (!manage) {
    if (filter.status === 'draft') return page([], 0, pagination);
    if (!filter.status) filter.status = { $ne: 'draft' };
  }
  const sort = filters.when === 'past' ? { drawAt: -1, _id: -1 } : { entryClosesAt: 1, _id: 1 };

  const [rows, total] = await Promise.all([
    LuckyDraw.find(filter).select('+fairness.seed').sort(sort).skip(pagination.skip).limit(pagination.limit).lean(),
    LuckyDraw.countDocuments(filter),
  ]);
  const ids = rows.map((r) => r._id);
  const [byDraw, mine, positions] = await Promise.all([
    counts(ctx.societyId, ids),
    LuckyDrawEntry.find({ society: ctx.societyId, draw: { $in: ids }, user: ctx.userId }).lean(),
    positionsOf(ctx.societyId, ctx.userId),
  ]);
  const myByDraw = new Map(mine.map((e) => [String(e.draw), e]));
  const items = [];
  for (const d of rows) {
    if (d.status !== 'drawn' && d.fairness) delete d.fairness.seed;
    // eslint-disable-next-line no-await-in-loop
    const reason = await ineligibleReason(ctx, d, positions);
    items.push(present(ctx, d, { manage, entrantCount: byDraw.get(String(d._id)) || 0, myEntry: myByDraw.get(String(d._id)), reason }));
  }
  return page(items, total, pagination);
}

export async function getById(ctx, id) {
  const manage = await canManage(ctx);
  const doc = await loadDraw(ctx, id, { manage, withSeed: true });
  const d = doc.toObject();
  if (d.status !== 'drawn' && d.fairness) delete d.fairness.seed;
  const [byDraw, myEntry, reason] = await Promise.all([
    counts(ctx.societyId, [d._id]),
    LuckyDrawEntry.findOne({ society: ctx.societyId, draw: d._id, user: ctx.userId }).lean(),
    ineligibleReason(ctx, d),
  ]);
  const out = present(ctx, d, { manage, entrantCount: byDraw.get(String(d._id)) || 0, myEntry, reason });
  const people = await memberSummaries(ctx.societyId, [d.createdBy, d.cancelledBy, mongoose.isValidObjectId(d.drawnBy) ? d.drawnBy : null]);
  out.createdBy = people.get(String(d.createdBy)) || null;
  out.drawnBy = d.drawnBy === 'scheduler' ? { name: 'Automatic (scheduled)' } : d.drawnBy ? people.get(String(d.drawnBy)) || { name: 'Member' } : null;
  out.cancelledBy = d.cancelledBy ? people.get(String(d.cancelledBy)) || { name: 'ColonyHub' } : null;
  return out;
}

export async function listEntries(ctx, id, { status, search }, pagination) {
  const draw = await LuckyDraw.findOne({ _id: id, society: ctx.societyId }).select('_id').lean();
  if (!draw) throw ApiError.notFound('Lucky draw not found');
  const filter = { society: ctx.societyId, draw: draw._id };
  if (status) filter.status = status;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { unitLabel: rx }];
  }
  const [items, total] = await Promise.all([
    LuckyDrawEntry.find(filter).sort({ createdAt: 1, _id: 1 }).skip(pagination.skip).limit(pagination.limit).select('-society -perFlat').lean(),
    LuckyDrawEntry.countDocuments(filter),
  ]);
  return page(items, total, pagination);
}

// Everything needed to re-run the draw by hand. Entry ids are opaque, so publishing them exposes nobody.
export async function verify(ctx, id) {
  const draw = (await loadDraw(ctx, id, { manage: false, withSeed: true })).toObject();
  const sealed = ['closed', 'drawn'].includes(draw.status) || phaseOf(draw) === 'closed';
  const drawn = draw.status === 'drawn';
  const active = sealed ? await LuckyDrawEntry.find({ society: ctx.societyId, draw: draw._id, status: 'entered' }).select('_id').lean() : [];
  const entryIds = active.map((e) => String(e._id)).sort();
  const out = {
    _id: draw._id,
    number: draw.number,
    title: draw.title,
    status: draw.status,
    algorithm: draw.fairness?.algorithm || ALGORITHM,
    seedHash: draw.fairness?.seedHash || null,
    seed: drawn ? draw.fairness.seed : null,
    seedMatches: drawn ? sha256(draw.fairness.seed) === draw.fairness.seedHash : null,
    entriesHash: draw.fairness?.entriesHash || null,
    entryIds,
    recomputedEntriesHash: sealed ? entriesHash(entryIds) : null,
    order: [],
  };
  if (drawn) {
    const outcome = new Map();
    for (const r of draw.results) for (const w of r.winners) outcome.set(String(w.entry), w.promotedFrom ? `${r.title} (reserve promoted)` : r.title);
    for (const r of draw.reservesList) if (!outcome.has(String(r.entry))) outcome.set(String(r.entry), 'Reserve');
    out.order = order(draw.fairness.seed, entryIds).map((o, i) => ({ rank: i + 1, ...o, outcome: outcome.get(o.entryId) || null }));
  }
  return out;
}

// ---------------- managing ----------------

function checkTimes({ entryOpensAt, entryClosesAt, drawAt }) {
  if (+entryClosesAt <= +entryOpensAt) throw ApiError.validation([{ field: 'body.entryClosesAt', message: 'Entries must close after they open' }]);
  if (+drawAt < +entryClosesAt) throw ApiError.validation([{ field: 'body.drawAt', message: 'The draw cannot happen before entries close' }]);
}

async function resolveCover(ctx, uploadId) {
  if (uploadId === null) return null;
  const [cover] = await uploads.resolve(ctx, [uploadId]);
  if (!cover?.mimetype?.startsWith('image/')) throw ApiError.badRequest('Cover must be an image');
  return cover;
}

export async function create(ctx, data) {
  checkTimes(data);
  if (data.entryClosesAt <= new Date()) throw ApiError.validation([{ field: 'body.entryClosesAt', message: 'Entries must close in the future' }]);
  const { coverImage, ...rest } = data;
  const draw = await LuckyDraw.create({
    ...rest,
    coverImage: coverImage ? await resolveCover(ctx, coverImage) : undefined,
    number: await nextNumber(ctx.societyId, 'luckyDraw', 'LD'),
    society: ctx.societyId,
    createdBy: ctx.userId,
    fairness: { algorithm: ALGORITHM },
  });
  audit.record(ctx, 'luckyDraw.created', 'LuckyDraw', draw._id, { number: draw.number, title: draw.title });
  return getById(ctx, draw._id);
}

const LIVE_EDITABLE = ['title', 'description', 'terms', 'coverImage'];

export async function update(ctx, id, data) {
  const draw = await LuckyDraw.findOne({ _id: id, society: ctx.societyId });
  if (!draw) throw ApiError.notFound('Lucky draw not found');
  if (draw.status !== 'draft' && draw.status !== 'open') throw ApiError.conflict('This draw can no longer be edited');
  if (draw.status === 'open') {
    // prizes, dates and rules are part of what people signed up for: frozen once published
    const locked = Object.keys(data).filter((k) => !LIVE_EDITABLE.includes(k));
    if (locked.length) throw ApiError.conflict('After publishing only the title, description, terms and cover can change');
  }
  const { coverImage, eligibility, ...rest } = data;
  checkTimes({
    entryOpensAt: rest.entryOpensAt || draw.entryOpensAt,
    entryClosesAt: rest.entryClosesAt || draw.entryClosesAt,
    drawAt: rest.drawAt || draw.drawAt,
  });
  Object.assign(draw, rest);
  if (eligibility) draw.set('eligibility', { ...draw.toObject().eligibility, ...eligibility });
  if (coverImage !== undefined) draw.coverImage = (await resolveCover(ctx, coverImage)) || undefined;
  await draw.save();
  audit.record(ctx, 'luckyDraw.updated', 'LuckyDraw', draw._id, { fields: Object.keys(data) });
  refresh(ctx.societyId);
  return getById(ctx, draw._id);
}

// Opens the draw and seals the seed: only its SHA-256 is visible until the results are out.
export async function publish(ctx, id) {
  const current = await LuckyDraw.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!current) throw ApiError.notFound('Lucky draw not found');
  if (current.status !== 'draft') throw ApiError.conflict('This draw is already published');
  if (new Date(current.entryClosesAt) <= new Date()) throw ApiError.conflict('The entry closing time has passed. Edit the dates first.');
  if (!current.prizes?.length) throw ApiError.conflict('Add at least one prize');
  const seed = newSeed();
  const draw = await LuckyDraw.findOneAndUpdate(
    { _id: id, society: ctx.societyId, status: 'draft' },
    { $set: { status: 'open', publishedAt: new Date(), 'fairness.seed': seed, 'fairness.seedHash': sha256(seed), 'fairness.algorithm': ALGORITHM }, $inc: { __v: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!draw) throw ApiError.conflict('This draw is already published');
  const now = new Date();
  const recipients = (await eligibleUserIds(ctx.societyId, draw)).filter((u) => !sameId(u, ctx.userId));
  const prizeText = draw.prizes.map((p) => `${p.quantity}× ${p.title}`).join(', ');
  await notifyUsers(ctx.societyId, recipients, {
    type: TYPE,
    title: `Lucky draw: ${draw.title}`,
    body: `${now < draw.entryOpensAt ? `Entries open ${fmt(draw.entryOpensAt)}` : 'Entries are open'} · free to join · closes ${fmt(draw.entryClosesAt)}. Prizes: ${prizeText}`.slice(0, 280),
    link: link(draw._id),
    channels: ['inapp', 'push'],
  });
  audit.record(ctx, 'luckyDraw.published', 'LuckyDraw', draw._id, { seedHash: draw.fairness.seedHash, notified: recipients.length });
  refresh(ctx.societyId);
  return getById(ctx, draw._id);
}

// Freezes the entry list and publishes its fingerprint.
async function sealEntries(drawId) {
  const active = await LuckyDrawEntry.find({ draw: drawId, status: 'entered' }).select('_id').lean();
  const hash = entriesHash(active.map((e) => e._id));
  await LuckyDraw.updateOne({ _id: drawId }, { $set: { 'fairness.entriesHash': hash, 'fairness.entryCount': active.length } });
  return { hash, count: active.length };
}

async function closeInternal(filter, now) {
  const before = await LuckyDraw.findOne({ ...filter, status: 'open' }).select('entryClosesAt').lean();
  if (!before) return null;
  const set = { status: 'closed', closedAt: now };
  if (new Date(before.entryClosesAt) > now) set.entryClosesAt = now; // closed early
  const draw = await LuckyDraw.findOneAndUpdate({ ...filter, status: 'open' }, { $set: set, $inc: { __v: 1 } }, { returnDocument: 'after' }).lean();
  if (!draw) return null;
  await sealEntries(draw._id);
  refresh(draw.society);
  return { draw, early: Boolean(set.entryClosesAt) };
}

export async function close(ctx, id) {
  const exists = await LuckyDraw.findOne({ _id: id, society: ctx.societyId }).select('status').lean();
  if (!exists) throw ApiError.notFound('Lucky draw not found');
  const res = await closeInternal({ _id: id, society: ctx.societyId }, new Date());
  if (!res) throw ApiError.conflict(exists.status === 'draft' ? 'Publish the draw first' : 'Entries are already closed');
  audit.record(ctx, 'luckyDraw.closed', 'LuckyDraw', id, { early: res.early });
  return getById(ctx, id);
}

// Runs the fair draw on a closed draw. The closed → drawn switch is a single conditional update, so two
// runs at once (two admins, or an admin and the scheduler) can't both draw: the second gets null.
async function performDraw(draw, by, now = new Date()) {
  const entries = await LuckyDrawEntry.find({ draw: draw._id, status: 'entered' }).lean();
  const { results, reserves } = assign(draw.fairness.seed, entries, draw.prizes, { perFlat: draw.eligibility?.perFlat, reserves: draw.reserves || 0 });
  const slot = ({ entry, position }) => ({ entry: entry._id, user: entry.user, unit: entry.unit, name: entry.name, unitLabel: entry.unitLabel, position });
  const prizeById = new Map(draw.prizes.map((p) => [String(p._id), p]));
  const resultDocs = results.map((r) => ({ prize: r.prize, title: prizeById.get(String(r.prize)).title, winners: r.winners.map(slot) }));
  const updated = await LuckyDraw.findOneAndUpdate(
    { _id: draw._id, status: 'closed' },
    {
      $set: {
        status: 'drawn',
        results: resultDocs,
        reservesList: reserves.map(slot),
        noEntrants: entries.length === 0,
        drawnAt: now,
        drawnBy: by,
        'fairness.entriesHash': entriesHash(entries.map((e) => e._id)),
        'fairness.entryCount': entries.length,
      },
      $inc: { __v: 1 },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) return null;

  const winnerIds = new Set();
  for (const r of updated.results) {
    for (const w of r.winners) {
      winnerIds.add(String(w.user));
      // eslint-disable-next-line no-await-in-loop
      await notifyUsers(updated.society, [w.user], {
        type: TYPE,
        title: `You won ${r.title}!`,
        body: `Congratulations — you won "${r.title}" in ${updated.title} (${updated.number}). The committee will contact you about collecting it.`,
        link: link(updated._id),
        channels: ['inapp', 'push', 'email', 'whatsapp'],
      });
    }
  }
  const others = entries.map((e) => String(e.user)).filter((u) => !winnerIds.has(u));
  await notifyUsers(updated.society, others, {
    type: TYPE,
    title: `Results are out: ${updated.title}`,
    body: 'Thanks for taking part. See the winners and check the draw was fair.',
    link: link(updated._id),
    channels: ['inapp', 'push'],
  });
  audit.record({ societyId: updated.society, userId: by === 'scheduler' ? null : by, ip: by === 'scheduler' ? 'scheduler' : undefined }, 'luckyDraw.drawn', 'LuckyDraw', updated._id, {
    entrants: entries.length,
    winners: winnerIds.size,
    reserves: updated.reservesList.length,
    by: by === 'scheduler' ? 'scheduler' : 'manual',
  });
  refresh(updated.society);
  return updated;
}

export async function runDraw(ctx, id) {
  const draw = await LuckyDraw.findOne({ _id: id, society: ctx.societyId }).select('+fairness.seed').lean();
  if (!draw) throw ApiError.notFound('Lucky draw not found');
  if (draw.status === 'drawn') throw ApiError.conflict('This draw has already been run');
  if (draw.status !== 'closed') throw ApiError.conflict(draw.status === 'open' ? 'Close entries before running the draw' : 'This draw cannot be run');
  const done = await performDraw(draw, ctx.userId);
  if (!done) throw ApiError.conflict('This draw has already been run');
  return getById(ctx, id);
}

function findWinner(draw, winnerId) {
  for (const r of draw.results) {
    const w = r.winners.id(winnerId);
    if (w) return { result: r, winner: w };
  }
  throw ApiError.notFound('Winner not found');
}

const saveOrConflict = (doc) =>
  doc.save().catch((err) => {
    if (err instanceof mongoose.Error.VersionError) throw ApiError.conflict('Someone else just changed this draw. Refresh and try again.');
    throw err;
  });

// A winner who can no longer receive the prize (moved out, ineligible) is replaced by the next unused reserve.
export async function promoteReserve(ctx, id, winnerId, { reason }) {
  const draw = await LuckyDraw.findOne({ _id: id, society: ctx.societyId });
  if (!draw) throw ApiError.notFound('Lucky draw not found');
  if (draw.status !== 'drawn') throw ApiError.conflict('The draw has not been run yet');
  const { result, winner } = findWinner(draw, winnerId);
  if (winner.status !== 'won') throw ApiError.conflict('This winner was already replaced');
  if (winner.handedOverAt) throw ApiError.conflict('This prize was already handed over');
  const reserve = draw.reservesList.find((r) => !r.usedFor);
  if (!reserve) throw ApiError.conflict('No reserves left for this draw');
  Object.assign(winner, { status: 'replaced', replacedAt: new Date(), replacedBy: ctx.userId, replacedReason: reason });
  Object.assign(reserve, { usedFor: result.prize, usedAt: new Date() });
  result.winners.push({ entry: reserve.entry, user: reserve.user, unit: reserve.unit, name: reserve.name, unitLabel: reserve.unitLabel, position: reserve.position, promotedFrom: winner._id });
  await saveOrConflict(draw);
  await notifyUsers(ctx.societyId, [reserve.user], {
    type: TYPE,
    title: `You won ${result.title}!`,
    body: `You were next on the reserve list for ${draw.title} (${draw.number}) and the prize "${result.title}" is now yours. The committee will contact you.`,
    link: link(draw._id),
    channels: ['inapp', 'push', 'email', 'whatsapp'],
  });
  audit.record(ctx, 'luckyDraw.reserve_promoted', 'LuckyDraw', draw._id, { prize: result.title, replaced: winner.user, promoted: reserve.user, reason });
  refresh(ctx.societyId);
  return getById(ctx, draw._id);
}

export async function markHandedOver(ctx, id, winnerId, { handedOverAt, note }) {
  const draw = await LuckyDraw.findOne({ _id: id, society: ctx.societyId });
  if (!draw) throw ApiError.notFound('Lucky draw not found');
  if (draw.status !== 'drawn') throw ApiError.conflict('The draw has not been run yet');
  const { result, winner } = findWinner(draw, winnerId);
  if (winner.status !== 'won') throw ApiError.conflict('This winner was replaced by a reserve');
  if (winner.handedOverAt) throw ApiError.conflict('Already marked as handed over');
  Object.assign(winner, { handedOverAt: handedOverAt || new Date(), handedOverBy: ctx.userId, handoverNote: note });
  await saveOrConflict(draw);
  audit.record(ctx, 'luckyDraw.prize_handed_over', 'LuckyDraw', draw._id, { prize: result.title, winner: winner.user, note });
  refresh(ctx.societyId);
  return getById(ctx, draw._id);
}

async function cancelInternal(ctx, filter, reason) {
  const current = await LuckyDraw.findOne(filter).select('status society').lean();
  if (!current) throw ApiError.notFound('Lucky draw not found');
  if (current.status === 'cancelled') throw ApiError.conflict('Already cancelled');
  if (current.status === 'drawn') throw ApiError.conflict('A completed draw cannot be cancelled');
  const draw = await LuckyDraw.findOneAndUpdate(
    { ...filter, status: { $in: ['draft', ...LIVE] } },
    { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: ctx.userId, cancelledReason: reason }, $inc: { __v: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!draw) throw ApiError.conflict('This draw changed meanwhile. Refresh and try again.');
  const entrants = await LuckyDrawEntry.find({ draw: draw._id, status: 'entered' }).select('user').lean();
  await notifyUsers(draw.society, entrants.map((e) => e.user), {
    type: TYPE,
    title: `Cancelled: ${draw.title}`,
    body: reason || 'This lucky draw was cancelled.',
    link: link(draw._id),
    channels: ['inapp', 'push'],
  });
  refresh(draw.society);
  return { draw, entrants: entrants.length };
}

export async function cancel(ctx, id, { reason }) {
  const { entrants } = await cancelInternal(ctx, { _id: id, society: ctx.societyId }, reason);
  audit.record(ctx, 'luckyDraw.cancelled', 'LuckyDraw', id, { reason, entrants });
  return getById(ctx, id);
}

// ---------------- entering ----------------

function checkWindow(draw, now = new Date()) {
  if (draw.status === 'cancelled') throw ApiError.conflict('This draw was cancelled');
  if (draw.status !== 'open' || now >= new Date(draw.entryClosesAt)) throw ApiError.conflict('Entries have closed');
  if (now < new Date(draw.entryOpensAt)) throw ApiError.conflict('Entries open on {date}', { params: { date: fmt(draw.entryOpensAt) } });
}

export async function enter(ctx, id) {
  const draw = (await loadDraw(ctx, id, { manage: false })).toObject();
  checkWindow(draw);
  const reason = await ineligibleReason(ctx, draw);
  if (reason) throw ApiError.forbidden(reason);
  const perFlat = Boolean(draw.eligibility?.perFlat);
  const existing = await LuckyDrawEntry.findOne({ society: ctx.societyId, draw: draw._id, user: ctx.userId }).lean();
  if (existing?.status === 'entered') throw ApiError.conflict("You're already in this draw");
  const flatTaken = () => ApiError.conflict('Someone from your flat has already entered — this draw allows one entry per flat');
  if (perFlat) {
    const flatmate = await LuckyDrawEntry.exists({ society: ctx.societyId, draw: draw._id, unit: ctx.unitId, status: 'entered', user: { $ne: ctx.userId } });
    if (flatmate) throw flatTaken();
  }
  const unit = await Unit.findById(ctx.unitId).select('label').lean();
  const snapshot = { unit: ctx.unitId, name: ctx.user?.name, unitLabel: unit?.label, perFlat, status: 'entered' };
  try {
    if (existing) {
      await LuckyDrawEntry.updateOne({ _id: existing._id, status: 'withdrawn' }, { $set: snapshot, $unset: { withdrawnAt: 1 } });
    } else {
      await LuckyDrawEntry.create({ society: ctx.societyId, draw: draw._id, user: ctx.userId, ...snapshot });
    }
  } catch (err) {
    if (err?.code === 11000) throw err.keyPattern?.unit ? flatTaken() : ApiError.conflict("You're already in this draw");
    throw err;
  }
  refresh(ctx.societyId);
  return getById(ctx, draw._id);
}

export async function withdraw(ctx, id) {
  const draw = (await loadDraw(ctx, id, { manage: false })).toObject();
  checkWindow(draw);
  const res = await LuckyDrawEntry.updateOne({ society: ctx.societyId, draw: draw._id, user: ctx.userId, status: 'entered' }, { status: 'withdrawn', withdrawnAt: new Date() });
  if (!res.modifiedCount) throw ApiError.notFound("You haven't entered this draw");
  refresh(ctx.societyId);
  return getById(ctx, draw._id);
}

// ---------------- scheduler ----------------

// Closes draws whose entry window has ended, then runs every closed draw whose draw time has come.
export async function closeAndDrawDue(now = new Date()) {
  const toClose = await LuckyDraw.find({ status: 'open', entryClosesAt: { $lte: now } }).select('_id').limit(200).lean();
  let closed = 0;
  for (const { _id } of toClose) {
    // eslint-disable-next-line no-await-in-loop
    if (await closeInternal({ _id }, now)) closed += 1;
  }
  const toDraw = await LuckyDraw.find({ status: 'closed', drawAt: { $lte: now } }).select('+fairness.seed').limit(50).lean();
  let drawn = 0;
  for (const d of toDraw) {
    // eslint-disable-next-line no-await-in-loop
    if (await performDraw(d, 'scheduler', now)) drawn += 1;
  }
  return { closed, drawn };
}

// ~24 hours before entries close, nudges eligible members who haven't joined yet. Once per draw.
export async function closingReminders(now = new Date()) {
  const due = await LuckyDraw.find({ status: 'open', reminderSentAt: null, entryOpensAt: { $lte: now }, entryClosesAt: { $gt: now, $lte: addHours(now, 24) } })
    .select('_id')
    .limit(100)
    .lean();
  let reminded = 0;
  for (const { _id } of due) {
    // eslint-disable-next-line no-await-in-loop
    const draw = await LuckyDraw.findOneAndUpdate({ _id, reminderSentAt: null }, { reminderSentAt: now }, { returnDocument: 'after' }).lean();
    if (!draw) continue; // another instance took it
    // eslint-disable-next-line no-await-in-loop
    const [eligible, entered] = await Promise.all([eligibleUserIds(draw.society, draw), LuckyDrawEntry.find({ draw: draw._id, status: 'entered' }).select('user').lean()]);
    const inSet = new Set(entered.map((e) => String(e.user)));
    const pending = eligible.filter((u) => !inSet.has(u));
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers(draw.society, pending, {
      type: TYPE,
      title: `Last day to join: ${draw.title}`,
      body: `Entries close ${fmt(draw.entryClosesAt)}. It's free — tap to participate.`,
      link: link(draw._id),
      channels: ['inapp', 'push'],
    });
    reminded += pending.length;
  }
  return { draws: due.length, reminded };
}

// ---------------- platform oversight ----------------

export async function listAll({ status, society }, pagination) {
  const filter = {};
  if (status) filter.status = status;
  if (society) filter.society = society;
  const [rows, total] = await Promise.all([
    LuckyDraw.find(filter).select('number title status society entryOpensAt entryClosesAt drawAt prizes drawnAt cancelledReason createdAt').sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).populate('society', 'name code').lean(),
    LuckyDraw.countDocuments(filter),
  ]);
  const byDraw = new Map();
  if (rows.length) {
    const agg = await LuckyDrawEntry.aggregate([{ $match: { draw: { $in: rows.map((r) => r._id) }, status: 'entered' } }, { $group: { _id: '$draw', n: { $sum: 1 } } }]);
    for (const r of agg) byDraw.set(String(r._id), r.n);
  }
  const items = rows.map((d) => ({ ...d, phase: phaseOf(d), entrantCount: byDraw.get(String(d._id)) || 0, totalPrizes: d.prizes.reduce((s, p) => s + p.quantity, 0) }));
  return page(items, total, pagination);
}

export async function platformCancel(platformUser, id, { reason }, ip) {
  const draw = await LuckyDraw.findById(id).select('society').lean();
  if (!draw) throw ApiError.notFound('Lucky draw not found');
  const pctx = { societyId: draw.society, userId: platformUser._id, role: ROLES.SUPER_ADMIN, ip };
  const res = await cancelInternal(pctx, { _id: id }, reason);
  audit.record(pctx, 'platform.luckyDraw_cancelled', 'LuckyDraw', id, { reason, entrants: res.entrants });
  recordPlatform({ userId: platformUser._id, ip }, 'luckydraw.cancelled', { targetType: 'LuckyDraw', targetId: id, society: draw.society, details: { reason, entrants: res.entrants, title: res.draw.title } });
  return { ...res.draw, phase: phaseOf(res.draw) };
}
