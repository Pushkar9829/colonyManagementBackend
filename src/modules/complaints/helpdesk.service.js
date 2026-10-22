import mongoose from 'mongoose';
import Complaint from './complaint.model.js';
import ComplaintCategory from './complaintCategory.model.js';
import EscalationRule from './escalationRule.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { COMPLAINT_CATEGORIES, ROLES } from '../../common/constants/index.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';

const HOUR = 3600 * 1000;
const ACTIVE = ['open', 'assigned', 'in_progress', 'on_hold', 'reopened'];
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const titleCase = (k) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Simple keyword map behind the "suggested category" on the create form. Societies can add their own
// keywords per category; these built-ins always apply to the default categories.
export const DEFAULT_KEYWORDS = {
  plumbing: ['leak', 'leaking', 'tap', 'pipe', 'drain', 'flush', 'toilet', 'sink', 'basin', 'clog', 'blocked', 'sewage', 'commode', 'shower'],
  electrical: ['light', 'fan', 'switch', 'socket', 'power', 'wiring', 'mcb', 'short circuit', 'bulb', 'voltage', 'electric', 'spark', 'geyser', 'meter'],
  lift: ['lift', 'elevator'],
  cleaning: ['garbage', 'trash', 'dirty', 'clean', 'cleaning', 'sweep', 'dust', 'waste', 'smell', 'stink', 'pest', 'cockroach', 'mosquito', 'rats'],
  security: ['theft', 'stolen', 'guard', 'cctv', 'camera', 'intruder', 'suspicious', 'stranger', 'trespass', 'unsafe'],
  parking: ['parking', 'parked', 'car', 'bike', 'scooter', 'vehicle', 'blocking', 'blocked my'],
  noise: ['noise', 'noisy', 'loud', 'music', 'party', 'barking', 'construction', 'drilling'],
  water: ['water supply', 'no water', 'tanker', 'water pressure', 'low pressure', 'water tank', 'motor', 'borewell', 'overflow', 'dirty water', 'muddy water'],
  other: [],
};

// Built-in matrix used when a society has not configured one.
export const DEFAULT_MATRIX = [
  { level: 1, afterHours: 0, roles: [ROLES.FACILITY_MANAGER], users: [], notifyAssignee: true },
  { level: 2, afterHours: 24, roles: [ROLES.ADMIN], users: [] },
  { level: 3, afterHours: 48, roles: [ROLES.ADMIN], users: [] },
];

// ---------- categories ----------
export async function listCategories(ctx, { includeInactive = false } = {}) {
  const docs = await ComplaintCategory.find({ society: ctx.societyId }).lean();
  const byKey = new Map(docs.map((d) => [d.key, d]));
  const defaults = COMPLAINT_CATEGORIES.map((key) => {
    const o = byKey.get(key);
    return {
      key,
      name: o?.name || titleCase(key),
      keywords: [...new Set([...(DEFAULT_KEYWORDS[key] || []), ...(o?.keywords || [])])],
      customKeywords: o?.keywords || [],
      requiresResolutionPhotos: Boolean(o?.requiresResolutionPhotos),
      active: o ? o.active : true,
      isDefault: true,
    };
  });
  const custom = docs
    .filter((d) => !COMPLAINT_CATEGORIES.includes(d.key))
    .map((d) => ({ _id: d._id, key: d.key, name: d.name, keywords: d.keywords, customKeywords: d.keywords, requiresResolutionPhotos: d.requiresResolutionPhotos, active: d.active, isDefault: false }));
  const all = [...defaults, ...custom];
  return includeInactive ? all : all.filter((c) => c.active);
}

export async function getCategory(ctx, key) {
  const cat = (await listCategories(ctx, { includeInactive: true })).find((c) => c.key === key);
  if (!cat) throw ApiError.badRequest('Unknown complaint category');
  return cat;
}

export async function assertActiveCategory(ctx, key) {
  const cat = await getCategory(ctx, key);
  if (!cat.active) throw ApiError.badRequest('The category "{name}" is no longer used', { params: { name: cat.name } });
  return cat;
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
const cleanKeywords = (list = []) => [...new Set(list.map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, 40);

export async function createCategory(ctx, { name, keywords, requiresResolutionPhotos }) {
  const key = slug(name);
  if (key.length < 2) throw ApiError.badRequest('Choose a longer name');
  if (COMPLAINT_CATEGORIES.includes(key) || (await ComplaintCategory.exists({ society: ctx.societyId, key }))) {
    throw ApiError.conflict('A category with this name already exists');
  }
  const doc = await ComplaintCategory.create({ society: ctx.societyId, key, name, keywords: cleanKeywords(keywords), requiresResolutionPhotos: Boolean(requiresResolutionPhotos) });
  audit.record(ctx, 'complaint_category.created', 'ComplaintCategory', doc._id, { key });
  return getCategory(ctx, key);
}

// Built-in categories are overridden by upserting a document with their key; they cannot be renamed.
export async function updateCategory(ctx, key, data) {
  const isDefault = COMPLAINT_CATEGORIES.includes(key);
  if (!isDefault && !(await ComplaintCategory.exists({ society: ctx.societyId, key }))) throw ApiError.notFound('Category not found');
  if (key === 'other' && data.active === false) throw ApiError.badRequest('"Other" must stay available');
  const set = {};
  if (data.name !== undefined && !isDefault) set.name = data.name;
  if (data.keywords !== undefined) set.keywords = cleanKeywords(data.keywords);
  if (data.requiresResolutionPhotos !== undefined) set.requiresResolutionPhotos = data.requiresResolutionPhotos;
  if (data.active !== undefined) set.active = data.active;
  await ComplaintCategory.updateOne(
    { society: ctx.societyId, key },
    { $set: set, $setOnInsert: { name: titleCase(key), isDefault } },
    { upsert: true },
  );
  audit.record(ctx, 'complaint_category.updated', 'ComplaintCategory', null, { key, ...data });
  return getCategory(ctx, key);
}

// Scores each category by how many of its keywords appear (as whole words) in the text.
export async function suggest(ctx, text) {
  const hay = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  let best = null;
  for (const c of await listCategories(ctx)) {
    const matched = c.keywords.filter((k) => hay.includes(` ${k.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `));
    if (matched.length && (!best || matched.length > best.matched.length)) best = { category: c.key, name: c.name, matched };
  }
  return best || { category: null, name: null, matched: [] };
}

// ---------- escalation matrix ----------
const RULE_POPULATE = { path: 'levels.users', select: 'name' };

export const listRules = (ctx) => EscalationRule.find({ society: ctx.societyId }).sort({ category: 1, priority: 1 }).populate(RULE_POPULATE).lean();

async function validateLevels(ctx, levels) {
  const sorted = [...levels].sort((a, b) => a.level - b.level);
  sorted.forEach((l, i) => {
    if (l.level !== i + 1) throw ApiError.badRequest('Levels must be 1, 2, 3 in order without gaps');
    if (i && l.afterHours <= sorted[i - 1].afterHours) throw ApiError.badRequest('Level {level} must come later than level {previous}', { params: { level: l.level, previous: l.level - 1 } });
    if (!l.roles?.length && !l.users?.length && !l.notifyAssignee) throw ApiError.badRequest('Level {level} has nobody to notify', { params: { level: l.level } });
  });
  const userIds = [...new Set(sorted.flatMap((l) => l.users || []).map(String))];
  if (userIds.length) {
    const members = await Membership.distinct('user', { society: ctx.societyId, user: { $in: userIds }, status: 'active' });
    if (members.length !== userIds.length) throw ApiError.badRequest('Escalation users must be active members of this society');
  }
  return sorted;
}

export async function createRule(ctx, data) {
  if (data.category) await getCategory(ctx, data.category);
  try {
    const rule = await EscalationRule.create({ ...data, levels: await validateLevels(ctx, data.levels), society: ctx.societyId, createdBy: ctx.userId });
    audit.record(ctx, 'escalation_rule.created', 'EscalationRule', rule._id, { category: data.category, priority: data.priority });
    return EscalationRule.findById(rule._id).populate(RULE_POPULATE).lean();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('A rule for this category and priority already exists');
    throw err;
  }
}

export async function updateRule(ctx, id, data) {
  const rule = await EscalationRule.findOne({ _id: id, society: ctx.societyId });
  if (!rule) throw ApiError.notFound('Rule not found');
  if (data.levels) rule.levels = await validateLevels(ctx, data.levels);
  if (data.active !== undefined) rule.active = data.active;
  await rule.save();
  audit.record(ctx, 'escalation_rule.updated', 'EscalationRule', rule._id, data);
  return EscalationRule.findById(rule._id).populate(RULE_POPULATE).lean();
}

export async function deleteRule(ctx, id) {
  const res = await EscalationRule.deleteOne({ _id: id, society: ctx.societyId });
  if (!res.deletedCount) throw ApiError.notFound('Rule not found');
  audit.record(ctx, 'escalation_rule.deleted', 'EscalationRule', id);
}

// Most specific active rule: category+priority, category, priority, catch-all; else the built-in matrix.
export function pickRule(rules, category, priority) {
  const active = rules.filter((r) => r.active);
  const find = (c, p) => active.find((r) => (r.category || null) === c && (r.priority || null) === p);
  return find(category, priority) || find(category, null) || find(null, priority) || find(null, null) || null;
}

export const defaultMatrix = () => ({ levels: DEFAULT_MATRIX });

async function recipientsFor(societyId, levels, assignee) {
  const roles = [...new Set(levels.flatMap((l) => l.roles || []))];
  const fromRoles = roles.length
    ? (await Membership.find({ society: societyId, role: { $in: roles }, status: 'active' }).select('user').lean()).map((m) => m.user)
    : [];
  const direct = levels.flatMap((l) => l.users || []);
  const withAssignee = levels.some((l) => l.notifyAssignee) && assignee ? [assignee] : [];
  return [...new Set([...fromRoles, ...direct, ...withAssignee].map(String))];
}

// Scheduled: moves overdue complaints up the matrix. A complaint jumps straight to the highest level
// whose time has come (e.g. after the server slept) and each level is notified once.
export async function runEscalations(now = new Date()) {
  const overdue = await Complaint.find({ status: { $in: ACTIVE }, slaDueAt: { $lt: now }, escalationLevel: { $lt: 3 } })
    .select('society ticketNumber title category priority slaDueAt assignedTo escalationLevel status')
    .limit(2000)
    .lean();
  const rulesBySociety = new Map();
  let escalated = 0;
  for (const c of overdue) {
    const key = String(c.society);
    if (!rulesBySociety.has(key)) rulesBySociety.set(key, await EscalationRule.find({ society: c.society, active: true }).lean()); // eslint-disable-line no-await-in-loop
    const matrix = pickRule(rulesBySociety.get(key), c.category, c.priority) || defaultMatrix();
    const hoursOverdue = (now - c.slaDueAt) / HOUR;
    const due = matrix.levels.filter((l) => l.afterHours <= hoursOverdue);
    const target = due.length ? Math.max(...due.map((l) => l.level)) : 0;
    const current = c.escalationLevel || 0;
    if (target <= current) continue;
    const newLevels = matrix.levels.filter((l) => l.level > current && l.level <= target);
    const notified = await recipientsFor(c.society, newLevels, c.assignedTo); // eslint-disable-line no-await-in-loop
    const note = `Escalated to level ${target} (${Math.floor(hoursOverdue)} h past SLA)`;
    // eslint-disable-next-line no-await-in-loop
    const res = await Complaint.updateOne(
      { _id: c._id, escalationLevel: current },
      {
        escalationLevel: target,
        $push: {
          escalations: { level: target, at: now, notified: notified.map(oid), hoursOverdue: Math.round(hoursOverdue * 10) / 10 },
          history: { from: c.status, to: c.status, note, kind: 'escalation', level: target, createdAt: now },
        },
      },
    );
    if (!res.modifiedCount) continue;
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers(c.society, notified, {
      type: 'complaint',
      title: `Escalation L${target}: ${c.ticketNumber}`,
      body: `${c.priority} · ${c.title} · ${Math.floor(hoursOverdue)} h past SLA`,
      link: `/complaints/${c._id}`,
      channels: target >= 3 ? ['inapp', 'push', 'sms', 'email'] : ['inapp', 'push'],
      urgent: target >= 3,
    });
    escalated += 1;
  }
  return { escalated };
}

// ---------- staff performance ----------
export async function staffPerformance(ctx, { from, to }) {
  const end = to ? new Date(`${to}T23:59:59.999+05:30`) : new Date();
  const start = from ? new Date(`${from}T00:00:00+05:30`) : new Date(end.getTime() - 30 * 24 * HOUR);
  if (end < start) throw ApiError.badRequest('"to" must be on or after "from"');
  const rows = await Complaint.aggregate([
    { $match: { society: oid(ctx.societyId), assignedTo: { $ne: null }, createdAt: { $gte: start, $lte: end } } },
    {
      $addFields: {
        doneAt: { $ifNull: ['$resolvedAt', '$closedAt'] },
      },
    },
    {
      $addFields: {
        isDone: { $and: [{ $in: ['$status', ['resolved', 'closed']] }, { $ne: ['$doneAt', null] }] },
      },
    },
    {
      $group: {
        _id: '$assignedTo',
        assigned: { $sum: 1 },
        resolved: { $sum: { $cond: ['$isDone', 1, 0] } },
        open: { $sum: { $cond: [{ $in: ['$status', ACTIVE] }, 1, 0] } },
        slaMet: { $sum: { $cond: [{ $and: ['$isDone', { $lte: ['$doneAt', '$slaDueAt'] }] }, 1, 0] } },
        resolutionHours: { $avg: { $cond: ['$isDone', { $divide: [{ $subtract: ['$doneAt', '$createdAt'] }, HOUR] }, null] } },
        avgRating: { $avg: '$rating' },
        rated: { $sum: { $cond: [{ $ifNull: ['$rating', false] }, 1, 0] } },
        escalated: { $sum: { $cond: [{ $gt: ['$escalationLevel', 0] }, 1, 0] } },
      },
    },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user', pipeline: [{ $project: { name: 1 } }] } },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    { $sort: { assigned: -1 } },
  ]);
  const designations = await Membership.find({ society: ctx.societyId, user: { $in: rows.map((r) => r._id) }, unit: null }).select('user role designation').lean();
  const desig = new Map(designations.map((m) => [String(m.user), m]));
  const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    from: start,
    to: end,
    rows: rows.map((r) => ({
      user: { _id: r._id, name: r.user?.name || 'Former member', role: desig.get(String(r._id))?.role, designation: desig.get(String(r._id))?.designation },
      assigned: r.assigned,
      resolved: r.resolved,
      open: r.open,
      escalated: r.escalated,
      avgResolutionHours: round1(r.resolutionHours),
      slaMetPercent: r.resolved ? Math.round((r.slaMet / r.resolved) * 1000) / 10 : null,
      avgRating: round1(r.avgRating),
      rated: r.rated,
    })),
  };
}
