import Notice from './notice.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { getPagination } from '../../common/utils/pagination.js';
import { audienceFilter, audienceUserIds } from '../../common/utils/audience.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';

const isManager = (ctx) => ['admin', 'facility_manager'].includes(ctx.role);
const same = (a, b) => String(a) === String(b);

const isPublished = (n, now = new Date()) => !n.publishAt || new Date(n.publishAt) <= now;

function present(ctx, n) {
  const { readBy = [], acks = [], ...rest } = n;
  const mine = acks.find((a) => same(a.user, ctx.userId));
  return {
    ...rest,
    isRead: readBy.some((id) => same(id, ctx.userId)),
    isAcknowledged: Boolean(mine),
    acknowledgedAt: mine?.at || null,
    scheduled: !isPublished(n),
    ...(isManager(ctx) ? { readCount: readBy.length, ackCount: acks.length } : {}),
  };
}

const recipientsOf = async (notice) =>
  (await audienceUserIds(notice.society, notice.audience)).filter((id) => !same(id, notice.createdBy));

// Notifies the audience once. Used at creation and by the scheduled-publish job.
export async function deliver(notice) {
  const claimed = await Notice.findOneAndUpdate({ _id: notice._id, notifiedAt: null }, { notifiedAt: new Date() }, { returnDocument: 'after' }).lean();
  if (!claimed) return false; // another instance already delivered it
  const channels = ['inapp', 'push', ...(claimed.sendEmail ? ['email'] : [])];
  const prefix = claimed.requiresAck ? 'Action needed: ' : '';
  await notifyUsers(claimed.society, await recipientsOf(claimed), {
    type: 'notice',
    title: `${prefix}${claimed.title}`,
    body: claimed.body.slice(0, claimed.sendEmail ? 4000 : 140),
    link: '/notices',
    channels,
    urgent: claimed.category === 'emergency',
  });
  return true;
}

export async function create(ctx, data) {
  const attachments = await uploads.resolve(ctx, data.attachments);
  const publishAt = data.publishAt && data.publishAt > new Date() ? data.publishAt : undefined;
  const notice = await Notice.create({ ...data, attachments, publishAt, society: ctx.societyId, createdBy: ctx.userId });
  if (!publishAt) await deliver(notice);
  audit.record(ctx, publishAt ? 'notice.scheduled' : 'notice.created', 'Notice', notice._id, { title: notice.title, publishAt });
  return present(ctx, (await Notice.findById(notice._id).lean()));
}

export async function list(ctx, filters, query) {
  const { page, limit, skip } = getPagination(query);
  const now = new Date();
  const and = [];
  const filter = {
    society: ctx.societyId,
    ...(await audienceFilter(ctx)),
    ...(filters.category ? { category: filters.category } : {}),
  };
  if (!isManager(ctx)) {
    and.push({ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] });
    and.push({ $or: [{ publishAt: null }, { publishAt: { $lte: now } }] });
  } else if (filters.scheduled) {
    filter.publishAt = { $gt: now };
  }
  if (filters.pendingAck) {
    filter.requiresAck = true;
    filter['acks.user'] = { $ne: ctx.userId };
  }
  if (and.length) filter.$and = and;
  const [items, total] = await Promise.all([
    Notice.find(filter).sort({ pinned: -1, createdAt: -1 }).skip(skip).limit(limit).populate('createdBy', 'name designation').lean(),
    Notice.countDocuments(filter),
  ]);
  return { items: items.map((n) => present(ctx, n)), meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

// A notice the viewer is allowed to see (published, in their audience).
async function visible(ctx, id) {
  const filter = { _id: id, society: ctx.societyId, ...(await audienceFilter(ctx)) };
  if (!isManager(ctx)) filter.$and = [{ $or: [{ publishAt: null }, { publishAt: { $lte: new Date() } }] }];
  const notice = await Notice.findOne(filter).lean();
  if (!notice) throw ApiError.notFound('Notice not found');
  return notice;
}

export async function markRead(ctx, id) {
  await visible(ctx, id);
  await Notice.updateOne({ _id: id, society: ctx.societyId }, { $addToSet: { readBy: ctx.userId } });
}

export async function acknowledge(ctx, id) {
  const notice = await visible(ctx, id);
  if (!notice.requiresAck) throw ApiError.badRequest('This notice does not need an acknowledgement');
  // The filter makes it idempotent: a second tap keeps the first timestamp.
  await Notice.updateOne(
    { _id: id, society: ctx.societyId, 'acks.user': { $ne: ctx.userId } },
    { $push: { acks: { user: ctx.userId, at: new Date() } }, $addToSet: { readBy: ctx.userId } },
  );
  return present(ctx, await Notice.findById(id).lean());
}

// Who in the audience has / hasn't acknowledged (managers).
export async function ackStatus(ctx, id) {
  const notice = await Notice.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!notice) throw ApiError.notFound('Notice not found');
  if (!notice.requiresAck) throw ApiError.badRequest('This notice does not need an acknowledgement');
  const ids = await recipientsOf(notice);
  const members = await Membership.find({ society: ctx.societyId, user: { $in: ids }, status: 'active' })
    .populate('user', 'name')
    .populate('unit', 'label')
    .lean();
  const byUser = new Map();
  for (const m of members) {
    if (!m.user) continue;
    const key = String(m.user._id);
    const row = byUser.get(key) || { user: m.user._id, name: m.user.name, role: m.role, units: [] };
    if (m.unit?.label) row.units.push(m.unit.label);
    byUser.set(key, row);
  }
  const ackAt = new Map(notice.acks.map((a) => [String(a.user), a.at]));
  const acknowledged = [];
  const pending = [];
  for (const row of byUser.values()) {
    const at = ackAt.get(String(row.user));
    if (at) acknowledged.push({ ...row, at });
    else pending.push(row);
  }
  const byName = (a, b) => (a.units[0] || '').localeCompare(b.units[0] || '') || a.name.localeCompare(b.name);
  return { total: byUser.size, acknowledged: acknowledged.sort(byName), pending: pending.sort(byName) };
}

// Reminds everyone who still hasn't acknowledged (managers).
export async function remindPending(ctx, id) {
  const { pending } = await ackStatus(ctx, id);
  const notice = await Notice.findById(id).select('title').lean();
  await notifyUsers(ctx.societyId, pending.map((p) => p.user), {
    type: 'notice',
    title: `Reminder: please acknowledge "${notice.title}"`,
    body: 'Open the notice board and tap "I\'ve read this".',
    link: '/notices',
  });
  return { reminded: pending.length };
}

export async function update(ctx, id, data) {
  const existing = await Notice.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!existing) throw ApiError.notFound('Notice not found');
  const set = { ...data };
  if ('publishAt' in data) {
    if (existing.notifiedAt || isPublished(existing)) throw ApiError.conflict('This notice is already published');
    set.publishAt = data.publishAt && data.publishAt > new Date() ? data.publishAt : null;
  }
  const notice = await Notice.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: set }, { returnDocument: 'after' }).lean();
  // rescheduled to "now": publish straight away
  if ('publishAt' in data && !notice.publishAt) await deliver(notice);
  return present(ctx, await Notice.findById(id).lean());
}

export async function remove(ctx, id) {
  const res = await Notice.deleteOne({ _id: id, society: ctx.societyId });
  if (!res.deletedCount) throw ApiError.notFound('Notice not found');
  audit.record(ctx, 'notice.deleted', 'Notice', id);
}

// Scheduled publish: notify the audience of notices whose publish time has arrived.
export async function publishDue(now = new Date()) {
  const due = await Notice.find({ notifiedAt: null, publishAt: { $ne: null, $lte: now } }).select('_id').limit(500).lean();
  let published = 0;
  for (const n of due) {
    // eslint-disable-next-line no-await-in-loop
    if (await deliver(n)) published += 1;
  }
  return { published };
}
