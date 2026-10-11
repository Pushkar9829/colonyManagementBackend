import ForumCategory from './forumCategory.model.js';
import ForumTopic from './forumTopic.model.js';
import ForumReply from './forumReply.model.js';
import ForumReport from './forumReport.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import * as directory from '../directory/directory.service.js';
import { isModerator, MODERATORS, memberSummaries, sameId } from '../directory/members.js';

export const EDIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_CATEGORIES = [
  { name: 'General', description: 'Anything about life in the society', order: 1 },
  { name: 'Suggestions', description: 'Ideas to make the society better', order: 2 },
  { name: 'Help & advice', description: 'Ask neighbours for recommendations', order: 3 },
  { name: 'Events & activities', description: 'Plan get-togethers, sports and hobbies', order: 4 },
  { name: 'Kids & parents', description: 'Play dates, schools, tuition', order: 5 },
];

const page = (items, total, { page: p, limit }) => ({ items, meta: { page: p, limit, total, pages: Math.ceil(total / limit) || 1 } });
const withinWindow = (doc) => Date.now() - new Date(doc.createdAt).getTime() <= EDIT_WINDOW_MS;
const person = (map, id) => map.get(String(id)) || { _id: id, name: 'Former member', roles: [], units: [] };

// ---------------- categories ----------------

export async function listCategories(ctx, { all } = {}) {
  if (!(await ForumCategory.exists({ society: ctx.societyId }))) {
    await ForumCategory.insertMany(DEFAULT_CATEGORIES.map((c) => ({ ...c, society: ctx.societyId })), { ordered: false }).catch(() => {});
  }
  const filter = { society: ctx.societyId };
  if (!(all && isModerator(ctx))) filter.active = true;
  const cats = await ForumCategory.find(filter).sort({ order: 1, name: 1 }).lean();
  const counts = await ForumTopic.aggregate([{ $match: { society: ctx.societyId, status: 'visible' } }, { $group: { _id: '$category', count: { $sum: 1 } } }]);
  const byId = new Map(counts.map((c) => [String(c._id), c.count]));
  return cats.map((c) => ({ ...c, topicCount: byId.get(String(c._id)) || 0 }));
}

export async function createCategory(ctx, data) {
  try {
    return (await ForumCategory.create({ ...data, society: ctx.societyId })).toObject();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('A category with this name already exists');
    throw err;
  }
}

export async function updateCategory(ctx, id, data) {
  const cat = await ForumCategory.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: data }, { returnDocument: 'after' }).lean();
  if (!cat) throw ApiError.notFound('Category not found');
  return cat;
}

// ---------------- mentions ----------------

// Mentioned ids must be active members of this society; anything else is silently dropped.
async function validMentions(ctx, ids = []) {
  const unique = [...new Set(ids.map(String))].filter((id) => !sameId(id, ctx.userId));
  if (!unique.length) return [];
  const rows = await Membership.find({ society: ctx.societyId, user: { $in: unique }, status: 'active' }).select('user').lean();
  return [...new Set(rows.map((r) => String(r.user)))];
}

// People the viewer may @mention: everyone already in the thread plus members visible in the directory.
export async function mentionable(ctx, { topic, search }) {
  const ids = new Set();
  if (topic) {
    const t = await ForumTopic.findOne({ _id: topic, society: ctx.societyId }).select('author').lean();
    if (t) {
      ids.add(String(t.author));
      for (const r of await ForumReply.find({ society: ctx.societyId, topic, status: 'visible' }).select('author').lean()) ids.add(String(r.author));
    }
  }
  const people = new Map();
  const participants = await memberSummaries(ctx.societyId, [...ids]);
  for (const p of participants.values()) people.set(String(p._id), { _id: p._id, name: p.name, units: p.units });
  for (const p of (await directory.list(ctx, {}, { page: 1, limit: 5000, skip: 0 })).items) people.set(String(p._id), { _id: p._id, name: p.name, units: p.units });
  const { committee, staff } = await directory.contacts(ctx);
  for (const p of [...committee, ...staff]) if (!people.has(String(p._id))) people.set(String(p._id), { _id: p._id, name: p.name, units: [], designation: p.designation });
  let list = [...people.values()].filter((p) => !sameId(p._id, ctx.userId));
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    list = list.filter((p) => re.test(p.name) || p.units.some((u) => re.test(u)));
  }
  return list.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20);
}

// ---------------- topics ----------------

function presentTopic(ctx, t, people) {
  const { likes = [], ...rest } = t;
  const hidden = t.status !== 'visible';
  const mine = sameId(t.author, ctx.userId);
  return {
    ...rest,
    body: hidden ? '' : t.body,
    attachments: hidden ? [] : t.attachments,
    author: person(people, t.author),
    mentions: undefined,
    likedByMe: likes.some((u) => sameId(u, ctx.userId)),
    isMine: mine,
    canEdit: mine && !hidden && withinWindow(t),
    canDelete: !hidden && ((mine && withinWindow(t)) || isModerator(ctx)),
    editableUntil: new Date(new Date(t.createdAt).getTime() + EDIT_WINDOW_MS),
    ...(isModerator(ctx) ? {} : { removedReason: undefined }),
  };
}

async function loadTopic(ctx, id) {
  const topic = await ForumTopic.findOne({ _id: id, society: ctx.societyId });
  if (!topic || (topic.status !== 'visible' && !isModerator(ctx) && !sameId(topic.author, ctx.userId))) throw ApiError.notFound('Topic not found');
  return topic;
}

export async function listTopics(ctx, filters, pagination) {
  const filter = { society: ctx.societyId, status: 'visible' };
  if (filters.category) filter.category = filters.category;
  if (filters.mine) filter.author = ctx.userId;
  if (filters.resolved !== undefined) filter.resolved = filters.resolved;
  if (filters.search) {
    const re = new RegExp(escapeRegex(filters.search), 'i');
    filter.$or = [{ title: re }, { body: re }];
  }
  const [rows, total] = await Promise.all([
    ForumTopic.find(filter).sort({ pinned: -1, lastActivityAt: -1 }).skip(pagination.skip).limit(pagination.limit).populate('category', 'name').lean(),
    ForumTopic.countDocuments(filter),
  ]);
  const people = await memberSummaries(ctx.societyId, rows.map((r) => r.author));
  // list rows carry a preview, not the whole post
  const items = rows.map((r) => {
    const t = presentTopic(ctx, r, people);
    return { ...t, body: t.body.length > 240 ? `${t.body.slice(0, 240)}…` : t.body };
  });
  return page(items, total, pagination);
}

export async function createTopic(ctx, data) {
  const category = await ForumCategory.findOne({ _id: data.category, society: ctx.societyId, active: true }).lean();
  if (!category) throw ApiError.badRequest('Choose a valid category');
  const attachments = await uploads.resolve(ctx, data.attachments);
  const mentions = await validMentions(ctx, data.mentions);
  const topic = await ForumTopic.create({ ...data, attachments, mentions, society: ctx.societyId, author: ctx.userId, lastActivityAt: new Date() });
  await notifyMentions(ctx, mentions, topic, topic.title);
  invalidate(ctx.societyId, ['forum']);
  return getTopic(ctx, topic._id);
}

async function notifyMentions(ctx, ids, topic, snippet) {
  if (!ids.length) return;
  const me = (await memberSummaries(ctx.societyId, [ctx.userId])).get(String(ctx.userId));
  await notifyUsers(ctx.societyId, ids, { type: 'forum', title: `${me?.name || 'Someone'} mentioned you`, body: `${topic.title}: ${snippet.slice(0, 100)}`, link: `/forum/${topic._id}` });
}

export async function getTopic(ctx, id, { page: p = 1, limit = 50 } = {}) {
  const topic = await loadTopic(ctx, id);
  const t = (await ForumTopic.findById(topic._id).populate('category', 'name').lean());
  const filter = { society: ctx.societyId, topic: t._id };
  const [replies, total] = await Promise.all([
    ForumReply.find(filter).sort({ createdAt: 1 }).skip((p - 1) * limit).limit(limit).lean(),
    ForumReply.countDocuments(filter),
  ]);
  const people = await memberSummaries(ctx.societyId, [t.author, ...replies.map((r) => r.author)]);
  return {
    ...presentTopic(ctx, t, people),
    replies: replies.map((r) => presentReply(ctx, r, people, t)),
    repliesMeta: { page: p, limit, total, pages: Math.ceil(total / limit) || 1 },
  };
}

export async function updateTopic(ctx, id, data) {
  const topic = await loadTopic(ctx, id);
  if (!sameId(topic.author, ctx.userId)) throw ApiError.forbidden('You can only edit your own posts');
  if (topic.status !== 'visible') throw ApiError.conflict('This topic is no longer visible');
  if (!withinWindow(topic)) throw ApiError.forbidden('Posts can only be edited within 15 minutes');
  if (data.category) {
    const ok = await ForumCategory.exists({ _id: data.category, society: ctx.societyId, active: true });
    if (!ok) throw ApiError.badRequest('Choose a valid category');
  }
  Object.assign(topic, data, { editedAt: new Date() });
  await topic.save();
  return getTopic(ctx, id);
}

export async function deleteTopic(ctx, id, reason) {
  const topic = await loadTopic(ctx, id);
  if (topic.status !== 'visible') throw ApiError.conflict('This topic is already removed');
  const mine = sameId(topic.author, ctx.userId);
  if (mine && withinWindow(topic)) {
    topic.status = 'deleted';
  } else if (isModerator(ctx)) {
    await moderate(ctx, 'topic', topic, reason || 'Removed by a moderator');
    return;
  } else {
    throw ApiError.forbidden(mine ? 'Posts can only be deleted within 15 minutes' : 'You can only delete your own posts');
  }
  await topic.save();
  invalidate(ctx.societyId, ['forum']);
}

async function toggleLike(Model, ctx, id, extraFilter = {}) {
  const base = { _id: id, society: ctx.societyId, status: 'visible', ...extraFilter };
  // two conditional updates keep likeCount exact under concurrent taps
  const unliked = await Model.findOneAndUpdate({ ...base, likes: ctx.userId }, { $pull: { likes: ctx.userId }, $inc: { likeCount: -1 } }, { returnDocument: 'after' }).lean();
  if (unliked) return { liked: false, likeCount: unliked.likeCount };
  const liked = await Model.findOneAndUpdate({ ...base, likes: { $ne: ctx.userId } }, { $addToSet: { likes: ctx.userId }, $inc: { likeCount: 1 } }, { returnDocument: 'after' }).lean();
  if (!liked) throw ApiError.notFound('Post not found');
  return { liked: true, likeCount: liked.likeCount };
}

export const likeTopic = (ctx, id) => toggleLike(ForumTopic, ctx, id);

export async function setResolved(ctx, id, resolved) {
  const topic = await loadTopic(ctx, id);
  if (!sameId(topic.author, ctx.userId) && !isModerator(ctx)) throw ApiError.forbidden('Only the author or a moderator can mark this resolved');
  topic.resolved = resolved;
  topic.resolvedAt = resolved ? new Date() : undefined;
  await topic.save();
  return getTopic(ctx, id);
}

export async function setFlag(ctx, id, flag, value) {
  const topic = await loadTopic(ctx, id);
  topic[flag] = value;
  await topic.save();
  audit.record(ctx, `forum.${flag === 'pinned' ? (value ? 'pinned' : 'unpinned') : value ? 'locked' : 'unlocked'}`, 'ForumTopic', topic._id, { title: topic.title });
  invalidate(ctx.societyId, ['forum']);
  return getTopic(ctx, id);
}

// ---------------- replies ----------------

function presentReply(ctx, r, people, topic) {
  const { likes = [], ...rest } = r;
  const hidden = r.status !== 'visible';
  const mine = sameId(r.author, ctx.userId);
  return {
    ...rest,
    body: hidden ? '' : r.body,
    author: person(people, r.author),
    mentions: undefined,
    likedByMe: likes.some((u) => sameId(u, ctx.userId)),
    isMine: mine,
    isTopicAuthor: sameId(r.author, topic.author),
    canEdit: mine && !hidden && withinWindow(r),
    canDelete: !hidden && ((mine && withinWindow(r)) || isModerator(ctx)),
    ...(isModerator(ctx) ? {} : { removedReason: undefined }),
  };
}

export async function addReply(ctx, topicId, { body, mentions: mentionIds }) {
  const topic = await loadTopic(ctx, topicId);
  if (topic.status !== 'visible') throw ApiError.conflict('This topic is no longer visible');
  if (topic.locked && !isModerator(ctx)) throw ApiError.forbidden('This topic is locked');
  const mentions = await validMentions(ctx, mentionIds);
  const reply = await ForumReply.create({ society: ctx.societyId, topic: topic._id, author: ctx.userId, body, mentions });
  await ForumTopic.updateOne({ _id: topic._id }, { $inc: { replyCount: 1 }, $set: { lastActivityAt: reply.createdAt } });

  const me = (await memberSummaries(ctx.societyId, [ctx.userId])).get(String(ctx.userId));
  if (!sameId(topic.author, ctx.userId)) {
    await notifyUsers(ctx.societyId, [topic.author], { type: 'forum', title: `${me?.name || 'Someone'} replied to "${topic.title}"`, body: body.slice(0, 140), link: `/forum/${topic._id}` });
  }
  await notifyMentions(ctx, mentions.filter((m) => !sameId(m, topic.author)), topic, body);
  invalidate(ctx.societyId, ['forum']);
  const people = await memberSummaries(ctx.societyId, [ctx.userId]);
  return presentReply(ctx, reply.toObject(), people, topic);
}

async function loadReply(ctx, id) {
  const reply = await ForumReply.findOne({ _id: id, society: ctx.societyId });
  if (!reply) throw ApiError.notFound('Reply not found');
  return reply;
}

export async function updateReply(ctx, id, { body }) {
  const reply = await loadReply(ctx, id);
  if (!sameId(reply.author, ctx.userId)) throw ApiError.forbidden('You can only edit your own posts');
  if (reply.status !== 'visible') throw ApiError.conflict('This reply is no longer visible');
  if (!withinWindow(reply)) throw ApiError.forbidden('Posts can only be edited within 15 minutes');
  reply.body = body;
  reply.editedAt = new Date();
  await reply.save();
  const topic = await ForumTopic.findById(reply.topic).select('author').lean();
  return presentReply(ctx, reply.toObject(), await memberSummaries(ctx.societyId, [reply.author]), topic);
}

export async function deleteReply(ctx, id, reason) {
  const reply = await loadReply(ctx, id);
  if (reply.status !== 'visible') throw ApiError.conflict('This reply is already removed');
  const mine = sameId(reply.author, ctx.userId);
  if (mine && withinWindow(reply)) {
    reply.status = 'deleted';
    await reply.save();
    await ForumTopic.updateOne({ _id: reply.topic }, { $inc: { replyCount: -1 } });
  } else if (isModerator(ctx)) {
    await moderate(ctx, 'reply', reply, reason || 'Removed by a moderator');
  } else {
    throw ApiError.forbidden(mine ? 'Posts can only be deleted within 15 minutes' : 'You can only delete your own posts');
  }
  invalidate(ctx.societyId, ['forum']);
}

export const likeReply = (ctx, id) => toggleLike(ForumReply, ctx, id);

// ---------------- moderation ----------------

// Hides a post, closes every open report on it and tells the author.
async function moderate(ctx, type, doc, reason) {
  doc.status = 'removed';
  doc.removedReason = reason;
  await doc.save();
  if (type === 'reply') await ForumTopic.updateOne({ _id: doc.topic }, { $inc: { replyCount: -1 } });
  await ForumReport.updateMany({ society: ctx.societyId, target: doc._id, status: 'open' }, { status: 'actioned', resolvedBy: ctx.userId, resolvedAt: new Date() });
  const topicId = type === 'topic' ? doc._id : doc.topic;
  if (!sameId(doc.author, ctx.userId)) {
    await notifyUsers(ctx.societyId, [doc.author], { type: 'forum', title: `Your ${type === 'topic' ? 'topic' : 'reply'} was removed by a moderator`, body: reason, link: `/forum/${topicId}` });
  }
  audit.record(ctx, `forum.${type}_removed`, type === 'topic' ? 'ForumTopic' : 'ForumReply', doc._id, { reason });
}

export async function report(ctx, { targetType, targetId, reason, note }) {
  const Model = targetType === 'topic' ? ForumTopic : ForumReply;
  const target = await Model.findOne({ _id: targetId, society: ctx.societyId, status: 'visible' }).lean();
  if (!target) throw ApiError.notFound('Post not found');
  if (sameId(target.author, ctx.userId)) throw ApiError.badRequest('You cannot report your own post');
  const topic = targetType === 'topic' ? target._id : target.topic;
  try {
    await ForumReport.create({ society: ctx.societyId, targetType, target: target._id, topic, reporter: ctx.userId, reason, note });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('You already reported this post');
    throw err;
  }
  const open = await ForumReport.countDocuments({ society: ctx.societyId, target: target._id, status: 'open' });
  if (open === 1) {
    await notifyRoles(ctx.societyId, MODERATORS, { type: 'forum', title: 'Forum post reported', body: `${reason.replace('_', ' ')}: ${(target.title || target.body).slice(0, 100)}`, link: '/forum?tab=moderation' });
  }
  return { reported: true };
}

// Moderation queue: open reports grouped per post, most reported first.
export async function listReports(ctx, { status = 'open' }, pagination) {
  const groups = await ForumReport.aggregate([
    { $match: { society: ctx.societyId, status } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$target', targetType: { $first: '$targetType' }, topic: { $first: '$topic' }, count: { $sum: 1 }, reasons: { $addToSet: '$reason' }, notes: { $push: '$note' }, reporters: { $push: '$reporter' }, lastAt: { $first: '$createdAt' }, reportIds: { $push: '$_id' } } },
    { $sort: { count: -1, lastAt: -1 } },
    { $facet: { rows: [{ $skip: pagination.skip }, { $limit: pagination.limit }], total: [{ $count: 'n' }] } },
  ]);
  const rows = groups[0]?.rows || [];
  const total = groups[0]?.total[0]?.n || 0;
  const topicIds = rows.filter((r) => r.targetType === 'topic').map((r) => r._id);
  const replyIds = rows.filter((r) => r.targetType === 'reply').map((r) => r._id);
  const [topics, replies, parents] = await Promise.all([
    ForumTopic.find({ _id: { $in: topicIds } }).select('title body author status locked').lean(),
    ForumReply.find({ _id: { $in: replyIds } }).select('body author status topic').lean(),
    ForumTopic.find({ _id: { $in: rows.map((r) => r.topic) } }).select('title').lean(),
  ]);
  const docs = new Map([...topics, ...replies].map((d) => [String(d._id), d]));
  const titles = new Map(parents.map((t) => [String(t._id), t.title]));
  const people = await memberSummaries(ctx.societyId, [...topics, ...replies].map((d) => d.author));
  const items = rows.map((r) => {
    const d = docs.get(String(r._id));
    return {
      target: r._id,
      targetType: r.targetType,
      topic: r.topic,
      topicTitle: titles.get(String(r.topic)) || '',
      count: r.count,
      reasons: r.reasons,
      notes: r.notes.filter(Boolean).slice(0, 5),
      lastAt: r.lastAt,
      content: d ? { title: d.title, body: d.body.slice(0, 500), status: d.status, author: person(people, d.author) } : null,
    };
  });
  return page(items, total, pagination);
}

export async function resolveReports(ctx, { targetType, targetId, action, reason }) {
  const Model = targetType === 'topic' ? ForumTopic : ForumReply;
  const doc = await Model.findOne({ _id: targetId, society: ctx.societyId });
  if (!doc) throw ApiError.notFound('Post not found');
  const open = await ForumReport.countDocuments({ society: ctx.societyId, target: doc._id, status: 'open' });
  if (!open) throw ApiError.conflict('There are no open reports for this post');
  if (action === 'remove') {
    if (doc.status === 'visible') await moderate(ctx, targetType, doc, reason || 'Removed after reports from neighbours');
  } else {
    await ForumReport.updateMany({ society: ctx.societyId, target: doc._id, status: 'open' }, { status: 'dismissed', resolvedBy: ctx.userId, resolvedAt: new Date() });
    audit.record(ctx, 'forum.reports_dismissed', targetType === 'topic' ? 'ForumTopic' : 'ForumReply', doc._id);
  }
  return { resolved: open };
}
