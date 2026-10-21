import LostFoundItem from './lostFoundItem.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { addDays, localDateString } from '../../common/utils/dates.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { isModerator, memberSummaries, sameId } from '../directory/members.js';

export const EXPIRY_DAYS = 30;

async function load(ctx, id) {
  const item = await LostFoundItem.findOne({ _id: id, society: ctx.societyId });
  if (!item) throw ApiError.notFound('Item not found');
  return item;
}

// Claims are private between the poster and each claimant; moderators see all of them.
async function present(ctx, doc) {
  const item = doc.toObject ? doc.toObject() : doc;
  const isPoster = sameId(item.postedBy, ctx.userId);
  const visibleClaims = isPoster || isModerator(ctx) ? item.claims : item.claims.filter((c) => sameId(c.by, ctx.userId));
  const people = await memberSummaries(ctx.societyId, [item.postedBy, ...visibleClaims.map((c) => c.by)]);
  const person = (id) => people.get(String(id)) || { _id: id, name: 'Former member', units: [] };
  const { claims, ...rest } = item;
  return {
    ...rest,
    postedBy: person(item.postedBy),
    isMine: isPoster,
    claimCount: claims.filter((c) => c.status === 'pending').length,
    claims: visibleClaims.map((c) => ({ ...c, by: person(c.by) })),
    myClaim: claims.find((c) => sameId(c.by, ctx.userId) && c.status !== 'withdrawn') || null,
  };
}

export async function create(ctx, data) {
  const photos = await uploads.resolve(ctx, data.photos);
  const item = await LostFoundItem.create({
    ...data,
    photos,
    date: data.date || localDateString(),
    society: ctx.societyId,
    postedBy: ctx.userId,
    unit: ctx.unitId || undefined,
    expiresAt: addDays(new Date(), EXPIRY_DAYS),
  });
  invalidate(ctx.societyId, ['lostFound']);
  return present(ctx, item);
}

export async function list(ctx, filters, { page, limit, skip }) {
  const filter = { society: ctx.societyId };
  if (filters.mine) filter.postedBy = ctx.userId;
  if (filters.kind) filter.kind = filters.kind;
  if (filters.category) filter.category = filters.category;
  filter.status = filters.status || (filters.mine ? { $exists: true } : 'open');
  if (filters.search) {
    const re = new RegExp(escapeRegex(filters.search), 'i');
    filter.$or = [{ title: re }, { description: re }, { location: re }];
  }
  const [rows, total] = await Promise.all([
    LostFoundItem.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    LostFoundItem.countDocuments(filter),
  ]);
  return { items: await Promise.all(rows.map((r) => present(ctx, r))), meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export const getById = async (ctx, id) => present(ctx, await load(ctx, id));

export async function update(ctx, id, data) {
  const item = await load(ctx, id);
  if (!sameId(item.postedBy, ctx.userId)) throw ApiError.forbidden('Only the person who posted this can edit it');
  if (item.status !== 'open') throw ApiError.conflict('This post is {status}', { params: { status: item.status } });
  const { photos: photoIds, ...rest } = data;
  Object.assign(item, rest);
  if (photoIds) item.photos = [...item.photos, ...(await uploads.resolve(ctx, photoIds))].slice(0, 6);
  await item.save();
  return present(ctx, item);
}

export async function remove(ctx, id) {
  const item = await load(ctx, id);
  const mine = sameId(item.postedBy, ctx.userId);
  if (!mine && !isModerator(ctx)) throw ApiError.forbidden();
  await item.deleteOne();
  if (!mine) audit.record(ctx, 'lostFound.removed', 'LostFoundItem', item._id, { title: item.title });
  invalidate(ctx.societyId, ['lostFound']);
}

export async function claim(ctx, id, { message }) {
  const item = await load(ctx, id);
  if (sameId(item.postedBy, ctx.userId)) throw ApiError.badRequest('You posted this item');
  if (item.status !== 'open') throw ApiError.conflict('This post is {status}', { params: { status: item.status } });
  const existing = item.claims.find((c) => sameId(c.by, ctx.userId) && c.status === 'pending');
  if (existing) throw ApiError.conflict('You already sent a claim for this item');
  item.claims.push({ by: ctx.userId, message });
  await item.save();
  const who = (await memberSummaries(ctx.societyId, [ctx.userId])).get(String(ctx.userId));
  await notifyUsers(ctx.societyId, [item.postedBy], {
    type: 'lostfound',
    title: item.kind === 'found' ? `${who?.name || 'Someone'} says "${item.title}" is theirs` : `${who?.name || 'Someone'} may have found "${item.title}"`,
    body: message.slice(0, 140),
    link: `/lost-found?item=${item._id}`,
  });
  return present(ctx, item);
}

export async function withdrawClaim(ctx, id) {
  const item = await load(ctx, id);
  const c = item.claims.find((x) => sameId(x.by, ctx.userId) && x.status === 'pending');
  if (!c) throw ApiError.notFound('You have no pending claim on this item');
  c.status = 'withdrawn';
  c.decidedAt = new Date();
  await item.save();
  return present(ctx, item);
}

// Poster confirms one claim: the item is resolved and the other pending claims are declined.
export async function decideClaim(ctx, id, claimId, accept) {
  const item = await load(ctx, id);
  if (!sameId(item.postedBy, ctx.userId)) throw ApiError.forbidden('Only the person who posted this can confirm a claim');
  if (item.status !== 'open') throw ApiError.conflict('This post is {status}', { params: { status: item.status } });
  const c = item.claims.id(claimId);
  if (!c || c.status !== 'pending') throw ApiError.notFound('Pending claim not found');
  const now = new Date();
  c.status = accept ? 'accepted' : 'rejected';
  c.decidedAt = now;
  const declined = [];
  if (accept) {
    item.status = 'resolved';
    item.resolvedWith = c.by;
    item.resolvedAt = now;
    for (const other of item.claims) {
      if (other.status === 'pending') {
        other.status = 'rejected';
        other.decidedAt = now;
        declined.push(other.by);
      }
    }
  }
  await item.save();
  await notifyUsers(ctx.societyId, [c.by], {
    type: 'lostfound',
    title: accept ? `Your claim on "${item.title}" was confirmed` : `Your claim on "${item.title}" was declined`,
    body: accept ? 'Message the poster to arrange the handover.' : 'The poster did not confirm your claim.',
    link: `/lost-found?item=${item._id}`,
  });
  if (declined.length) {
    await notifyUsers(ctx.societyId, declined, { type: 'lostfound', title: `"${item.title}" has been returned`, body: 'The poster confirmed another claim.', link: `/lost-found?item=${item._id}` });
  }
  invalidate(ctx.societyId, ['lostFound']);
  return present(ctx, item);
}

// Poster closes the post without a claim (found it themselves, gave it to the office...).
export async function close(ctx, id, { status }) {
  const item = await load(ctx, id);
  if (!sameId(item.postedBy, ctx.userId) && !isModerator(ctx)) throw ApiError.forbidden();
  if (status === 'open') {
    if (!['expired', 'closed'].includes(item.status)) throw ApiError.conflict('Only closed or expired posts can be reopened');
    item.status = 'open';
    item.expiresAt = addDays(new Date(), EXPIRY_DAYS);
  } else {
    if (item.status !== 'open') throw ApiError.conflict('This post is {status}', { params: { status: item.status } });
    item.status = status;
    if (status === 'resolved') item.resolvedAt = new Date();
    for (const c of item.claims) if (c.status === 'pending') Object.assign(c, { status: 'rejected', decidedAt: new Date() });
  }
  await item.save();
  invalidate(ctx.societyId, ['lostFound']);
  return present(ctx, item);
}

// Job: open posts older than 30 days expire; the poster is told and can reopen.
export async function expireOld(now = new Date()) {
  const due = await LostFoundItem.find({ status: 'open', expiresAt: { $lte: now } }).select('society postedBy title').limit(1000).lean();
  for (const item of due) {
    // eslint-disable-next-line no-await-in-loop
    const res = await LostFoundItem.updateOne({ _id: item._id, status: 'open' }, { status: 'expired' });
    if (res.modifiedCount) {
      // eslint-disable-next-line no-await-in-loop
      await notifyUsers(item.society, [item.postedBy], {
        type: 'lostfound',
        title: `Your post "${item.title}" expired`,
        body: `Lost & found posts close after ${EXPIRY_DAYS} days. Reopen it if you still need it.`,
        link: `/lost-found?item=${item._id}`,
      });
    }
  }
  return { expired: due.length };
}
