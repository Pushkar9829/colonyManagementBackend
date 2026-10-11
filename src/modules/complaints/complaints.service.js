import Complaint from './complaint.model.js';
import Society from '../society/society.model.js';
import User from '../users/user.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { addHours } from '../../common/utils/dates.js';
import { ROLES } from '../../common/constants/index.js';
import { nextNumber } from '../counter/counter.service.js';
import * as uploads from '../uploads/uploads.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import * as helpdesk from './helpdesk.service.js';

const ACTIVE = ['open', 'assigned', 'in_progress', 'on_hold', 'reopened'];
const ASSIGNABLE_ROLES = [ROLES.STAFF, ROLES.FACILITY_MANAGER, ROLES.ADMIN];
const POPULATE = [
  { path: 'unit', select: 'label' },
  { path: 'raisedBy', select: 'name phone' },
  { path: 'assignedTo', select: 'name designation phone' },
  { path: 'comments.by', select: 'name role' },
  { path: 'history.by', select: 'name' },
];

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
const isStaff = (ctx) => ctx.role === ROLES.STAFF;

function scopeFilter(ctx) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.raisedBy = ctx.userId;
  if (isStaff(ctx)) filter.assignedTo = ctx.userId;
  return filter;
}

async function load(ctx, id) {
  const complaint = await Complaint.findOne({ ...scopeFilter(ctx), _id: id });
  if (!complaint) throw ApiError.notFound('Complaint not found');
  return complaint;
}

function present(ctx, doc) {
  const c = doc.toObject ? doc.toObject() : doc;
  if (isResident(ctx)) c.comments = (c.comments || []).filter((x) => !x.internal);
  c.isOverdue = Boolean(c.slaDueAt && ACTIVE.includes(c.status) && new Date(c.slaDueAt) < new Date());
  return c;
}

async function reload(ctx, id) {
  const c = present(ctx, await Complaint.findById(id).populate(POPULATE).lean());
  const cat = await helpdesk.getCategory(ctx, c.category).catch(() => null);
  c.categoryName = cat?.name || c.category;
  c.requiresResolutionPhotos = Boolean(cat?.requiresResolutionPhotos);
  return c;
}

export async function create(ctx, data) {
  await helpdesk.assertActiveCategory(ctx, data.category);
  const society = await Society.findById(ctx.societyId).select('settings.complaintSlaHours').lean();
  const slaHours = society?.settings?.complaintSlaHours?.[data.priority] ?? 48;
  const attachments = await uploads.resolve(ctx, data.attachments);
  const complaint = await Complaint.create({
    ...data,
    attachments,
    society: ctx.societyId,
    unit: ctx.unitId || undefined,
    raisedBy: ctx.userId,
    ticketNumber: await nextNumber(ctx.societyId, 'complaint', 'CMP'),
    slaDueAt: addHours(new Date(), slaHours),
    history: [{ by: ctx.userId, to: 'open' }],
  });
  await notifyRoles(ctx.societyId, [ROLES.ADMIN, ROLES.FACILITY_MANAGER], {
    type: 'complaint',
    title: `New complaint ${complaint.ticketNumber}`,
    body: `${data.category}: ${data.title}`,
    link: `/complaints/${complaint._id}`,
  });
  return reload(ctx, complaint._id);
}

export async function list(ctx, filters, pagination) {
  const filter = scopeFilter(ctx);
  if (filters.status) filter.status = filters.status;
  if (filters.category) filter.category = filters.category;
  if (filters.priority) filter.priority = filters.priority;
  if (filters.assignedTo) filter.assignedTo = filters.assignedTo;
  if (filters.mine) filter.assignedTo = ctx.userId;
  if (filters.overdue) {
    filter.status = { $in: ACTIVE };
    filter.slaDueAt = { $lt: new Date() };
  }
  const result = await paginate(Complaint, filter, pagination, {
    select: '-comments -history',
    populate: POPULATE.slice(0, 3),
  });
  result.items = result.items.map((c) => present(ctx, c));
  return result;
}

export const getById = async (ctx, id) => {
  await load(ctx, id);
  return reload(ctx, id);
};

function transition(complaint, by, to, note) {
  complaint.history.push({ by, from: complaint.status, to, note });
  complaint.status = to;
  if (to === 'resolved') complaint.resolvedAt = new Date();
  if (to === 'closed') complaint.closedAt = new Date();
}

export async function assign(ctx, id, assignedTo) {
  const complaint = await load(ctx, id);
  const staff = await Membership.findOne({ user: assignedTo, society: ctx.societyId, role: { $in: ASSIGNABLE_ROLES }, status: 'active' }).lean();
  const assignee = staff && (await User.findById(assignedTo).select('name').lean());
  if (!assignee) throw ApiError.badRequest('Assignee must be an active staff member');
  if (['closed'].includes(complaint.status)) throw ApiError.conflict('Closed complaints cannot be reassigned');
  complaint.assignedTo = assignee._id;
  transition(complaint, ctx.userId, 'assigned', `Assigned to ${assignee.name}`);
  await complaint.save();
  await notifyUsers(ctx.societyId, [assignee._id], {
    type: 'complaint',
    title: `Complaint ${complaint.ticketNumber} assigned to you`,
    body: complaint.title,
    link: `/complaints/${complaint._id}`,
  });
  return reload(ctx, complaint._id);
}

const STAFF_TRANSITIONS = {
  open: ['in_progress', 'on_hold', 'resolved', 'closed'],
  assigned: ['in_progress', 'on_hold', 'resolved', 'closed'],
  reopened: ['in_progress', 'on_hold', 'resolved', 'closed'],
  in_progress: ['on_hold', 'resolved', 'closed'],
  on_hold: ['in_progress', 'resolved', 'closed'],
  resolved: ['closed'],
  closed: [],
};

export async function changeStatus(ctx, id, { status, note, beforePhotos, afterPhotos }) {
  const complaint = await load(ctx, id);
  if (!STAFF_TRANSITIONS[complaint.status].includes(status)) {
    throw ApiError.conflict(`Cannot move from ${complaint.status} to ${status}`);
  }
  if (isStaff(ctx) && status === 'closed') throw ApiError.forbidden('Only managers can close complaints');
  const before = await uploads.resolve(ctx, beforePhotos);
  const after = await uploads.resolve(ctx, afterPhotos);
  if (status === 'resolved') {
    const cat = await helpdesk.getCategory(ctx, complaint.category).catch(() => null);
    const hasBefore = complaint.resolutionPhotos.before.length + before.length > 0;
    const hasAfter = complaint.resolutionPhotos.after.length + after.length > 0;
    if (cat?.requiresResolutionPhotos && !(hasBefore && hasAfter)) {
      throw ApiError.validation([
        ...(hasBefore ? [] : [{ field: 'body.beforePhotos', message: 'Attach a photo taken before the work' }]),
        ...(hasAfter ? [] : [{ field: 'body.afterPhotos', message: 'Attach a photo of the finished work' }]),
      ]);
    }
  }
  complaint.resolutionPhotos.before.push(...before);
  complaint.resolutionPhotos.after.push(...after);
  transition(complaint, ctx.userId, status, note);
  await complaint.save();
  await notifyUsers(ctx.societyId, [complaint.raisedBy], {
    type: 'complaint',
    title: `${complaint.ticketNumber} is now ${status.replace('_', ' ')}`,
    body: note || complaint.title,
    link: `/complaints/${complaint._id}`,
  });
  return reload(ctx, complaint._id);
}

export async function addComment(ctx, id, { text, internal, attachments: ids }) {
  const complaint = await load(ctx, id);
  const attachments = await uploads.resolve(ctx, ids);
  const isInternal = Boolean(internal) && !isResident(ctx);
  complaint.comments.push({ by: ctx.userId, text, internal: isInternal, attachments });
  await complaint.save();
  if (!isInternal) {
    const recipients = isResident(ctx) ? [complaint.assignedTo].filter(Boolean) : [complaint.raisedBy];
    await notifyUsers(ctx.societyId, recipients, { type: 'complaint', title: `New comment on ${complaint.ticketNumber}`, body: text.slice(0, 120), link: `/complaints/${complaint._id}` });
  }
  return reload(ctx, complaint._id);
}

export async function reopen(ctx, id, note) {
  const complaint = await load(ctx, id);
  if (!['resolved', 'closed'].includes(complaint.status)) throw ApiError.conflict('Only resolved or closed complaints can be reopened');
  transition(complaint, ctx.userId, 'reopened', note);
  complaint.rating = undefined;
  // a reopened ticket gets a fresh SLA clock
  const society = await Society.findById(ctx.societyId).select('settings.complaintSlaHours').lean();
  complaint.slaDueAt = addHours(new Date(), society?.settings?.complaintSlaHours?.[complaint.priority] ?? 48);
  complaint.slaEscalatedAt = undefined;
  complaint.escalationLevel = 0;
  await complaint.save();
  await notifyRoles(ctx.societyId, [ROLES.ADMIN, ROLES.FACILITY_MANAGER], { type: 'complaint', title: `${complaint.ticketNumber} reopened`, body: note, link: `/complaints/${complaint._id}` });
  return reload(ctx, complaint._id);
}

export async function rate(ctx, id, { rating, feedback }) {
  const complaint = await load(ctx, id);
  if (!['resolved', 'closed'].includes(complaint.status)) throw ApiError.conflict('You can rate only after the complaint is resolved');
  complaint.rating = rating;
  complaint.feedback = feedback;
  if (complaint.status === 'resolved') transition(complaint, ctx.userId, 'closed', `Rated ${rating}/5`);
  await complaint.save();
  return reload(ctx, complaint._id);
}

export async function stats(ctx) {
  const rows = await Complaint.aggregate([
    { $match: { society: ctx.societyId } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        active: { $sum: { $cond: [{ $in: ['$status', ACTIVE] }, 1, 0] } },
        overdue: { $sum: { $cond: [{ $and: [{ $in: ['$status', ACTIVE] }, { $lt: ['$slaDueAt', new Date()] }] }, 1, 0] } },
        avgRating: { $avg: '$rating' },
        avgResolutionHours: {
          $avg: { $cond: [{ $ifNull: ['$resolvedAt', false] }, { $divide: [{ $subtract: ['$resolvedAt', '$createdAt'] }, 3600000] }, null] },
        },
      },
    },
  ]);
  const byCategory = await Complaint.aggregate([
    { $match: { society: ctx.societyId, status: { $in: ACTIVE } } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  return { ...(rows[0] || { total: 0, active: 0, overdue: 0, avgRating: null, avgResolutionHours: null }), _id: undefined, byCategory };
}
