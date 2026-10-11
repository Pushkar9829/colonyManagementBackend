import SupportTicket, { SUPPORT_ACTIVE, SUPPORT_SLA_HOURS } from './supportTicket.model.js';
import Society from '../society/society.model.js';
import User from '../users/user.model.js';
import Membership from '../users/membership.model.js';
import { nextPlatformNumber } from '../subscriptions/platformCounter.model.js';
import { appLink, emailPlatformTeam } from '../subscriptions/platformMail.js';
import * as uploads from '../uploads/uploads.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { addHours } from '../../common/utils/dates.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { ROLES } from '../../common/constants/index.js';

const POPULATE = [
  { path: 'raisedBy', select: 'name email phone' },
  { path: 'assignedTo', select: 'name email' },
  { path: 'messages.by', select: 'name' },
  { path: 'history.by', select: 'name' },
];
const LIST_POPULATE = [
  { path: 'raisedBy', select: 'name' },
  { path: 'assignedTo', select: 'name' },
  { path: 'society', select: 'name code city' },
];

const isAdmin = (ctx) => ctx.role === ROLES.ADMIN;

function present(doc) {
  const t = doc.toObject ? doc.toObject() : doc;
  t.slaBreached = Boolean(t.slaDueAt && (t.firstResponseAt ? t.firstResponseAt > t.slaDueAt : SUPPORT_ACTIVE.includes(t.status) && new Date(t.slaDueAt) < new Date()));
  return t;
}

// Society admins see every ticket of their society; FM / accountant see the ones they raised.
function scope(ctx) {
  const filter = { society: ctx.societyId };
  if (!isAdmin(ctx)) filter.raisedBy = ctx.userId;
  return filter;
}

async function load(filter) {
  const ticket = await SupportTicket.findOne(filter);
  if (!ticket) throw ApiError.notFound('Ticket not found');
  return ticket;
}

const reload = async (id) => present(await SupportTicket.findById(id).populate(POPULATE).populate('society', 'name code city').lean());

function move(ticket, by, to, note) {
  if (ticket.status === to) return;
  ticket.history.push({ by, from: ticket.status, to, note });
  ticket.status = to;
  if (to === 'resolved') ticket.resolvedAt = new Date();
  if (to === 'closed') ticket.closedAt = new Date();
}

// People on the society side who hear about platform replies: the requester and the society's admins.
async function societyRecipients(ticket) {
  const admins = await Membership.find({ society: ticket.society, role: ROLES.ADMIN, status: 'active' }).select('user').lean();
  return [ticket.raisedBy, ...admins.map((a) => a.user)];
}

async function tellSociety(ticket, title, body) {
  await notifyUsers(ticket.society, await societyRecipients(ticket), { type: 'support', title, body, link: `/support?ticket=${ticket._id}`, channels: ['inapp', 'email'] });
}

async function tellPlatform(ticket, subject, text) {
  const society = await Society.findById(ticket.society).select('name code').lean();
  await emailPlatformTeam({ subject: `[${ticket.number}] ${subject}`, text: `${society?.name} (${society?.code})\n\n${text}\n\nOpen the console: ${appLink(`/platform/support?ticket=${ticket._id}`)}` });
}

// ---------- society side ----------
export async function create(ctx, data) {
  const attachments = await uploads.resolve(ctx, data.attachments);
  const ticket = await SupportTicket.create({
    ...data,
    attachments,
    society: ctx.societyId,
    raisedBy: ctx.userId,
    raisedByRole: ctx.role,
    number: await nextPlatformNumber('support_ticket', 'SUP'),
    slaDueAt: addHours(new Date(), SUPPORT_SLA_HOURS[data.priority]),
    history: [{ by: ctx.userId, to: 'open' }],
  });
  audit.record(ctx, 'support.ticket_created', 'SupportTicket', ticket._id, { number: ticket.number, category: ticket.category });
  await tellPlatform(ticket, `New ${data.priority} ticket: ${data.subject}`, `${data.category} · ${data.description || ''}`);
  return reload(ticket._id);
}

export async function list(ctx, filters, pagination) {
  const filter = scope(ctx);
  if (filters.status) filter.status = filters.status;
  if (filters.active) filter.status = { $in: SUPPORT_ACTIVE };
  const result = await paginate(SupportTicket, filter, pagination, { select: '-messages -history', populate: LIST_POPULATE.slice(0, 2), sort: { lastActivityAt: -1 } });
  result.items = result.items.map(present);
  return result;
}

export async function getById(ctx, id) {
  await load({ ...scope(ctx), _id: id });
  return reload(id);
}

export async function reply(ctx, id, { text, attachments: ids }) {
  const ticket = await load({ ...scope(ctx), _id: id });
  if (ticket.status === 'closed') throw ApiError.conflict('This ticket is closed. Reopen it to continue.');
  const attachments = await uploads.resolve(ctx, ids);
  ticket.messages.push({ by: ctx.userId, side: 'society', text, attachments });
  if (['waiting_on_customer', 'resolved'].includes(ticket.status)) move(ticket, ctx.userId, 'in_progress', 'Customer replied');
  ticket.awaiting = 'platform';
  ticket.lastActivityAt = new Date();
  await ticket.save();
  await tellPlatform(ticket, `Reply from society: ${ticket.subject}`, text);
  return reload(ticket._id);
}

export async function close(ctx, id, { rating }) {
  const ticket = await load({ ...scope(ctx), _id: id });
  if (ticket.status === 'closed') throw ApiError.conflict('Ticket is already closed');
  move(ticket, ctx.userId, 'closed', 'Closed by society');
  if (rating) ticket.rating = rating;
  ticket.awaiting = 'none';
  ticket.lastActivityAt = new Date();
  await ticket.save();
  return reload(ticket._id);
}

export async function reopen(ctx, id, { note }) {
  const ticket = await load({ ...scope(ctx), _id: id });
  if (!['resolved', 'closed'].includes(ticket.status)) throw ApiError.conflict('Only resolved or closed tickets can be reopened');
  move(ticket, ctx.userId, 'open', note);
  ticket.messages.push({ by: ctx.userId, side: 'society', text: note });
  ticket.awaiting = 'platform';
  ticket.lastActivityAt = new Date();
  await ticket.save();
  await tellPlatform(ticket, `Reopened: ${ticket.subject}`, note);
  return reload(ticket._id);
}

// ---------- platform side ----------
export async function listAll(filters, pagination) {
  const filter = {};
  if (filters.status) filter.status = filters.status;
  if (filters.active) filter.status = { $in: SUPPORT_ACTIVE };
  if (filters.priority) filter.priority = filters.priority;
  if (filters.category) filter.category = filters.category;
  if (filters.society) filter.society = filters.society;
  if (filters.awaiting) filter.awaiting = filters.awaiting;
  if (filters.mine) filter.assignedTo = filters.userId;
  if (filters.breached) {
    filter.status = { $in: SUPPORT_ACTIVE };
    filter.firstResponseAt = null;
    filter.slaDueAt = { $lt: new Date() };
  }
  if (filters.search) {
    const rx = { $regex: escapeRegex(filters.search), $options: 'i' };
    filter.$or = [{ subject: rx }, { number: rx }];
  }
  const result = await paginate(SupportTicket, filter, pagination, { select: '-messages -history', populate: LIST_POPULATE, sort: { lastActivityAt: -1 } });
  result.items = result.items.map(present);
  return result;
}

export async function stats() {
  const now = new Date();
  const [byStatus, awaitingPlatform, breached] = await Promise.all([
    SupportTicket.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    SupportTicket.countDocuments({ status: { $in: SUPPORT_ACTIVE }, awaiting: 'platform' }),
    SupportTicket.countDocuments({ status: { $in: SUPPORT_ACTIVE }, firstResponseAt: null, slaDueAt: { $lt: now } }),
  ]);
  return { byStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.count])), awaitingPlatform, breached };
}

export async function getAny(id) {
  await load({ _id: id });
  return reload(id);
}

export async function platformReply(platformUser, id, { text, status }) {
  const ticket = await load({ _id: id });
  if (ticket.status === 'closed') throw ApiError.conflict('This ticket is closed');
  ticket.messages.push({ by: platformUser._id, side: 'platform', text });
  if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();
  if (!ticket.assignedTo) ticket.assignedTo = platformUser._id;
  move(ticket, platformUser._id, status || 'waiting_on_customer');
  ticket.awaiting = ['resolved', 'closed'].includes(ticket.status) ? 'none' : 'society';
  ticket.lastActivityAt = new Date();
  await ticket.save();
  await tellSociety(ticket, `ColonyHub support replied on ${ticket.number}`, text.slice(0, 200));
  return reload(ticket._id);
}

export async function setStatus(platformUser, id, { status, note }) {
  const ticket = await load({ _id: id });
  if (ticket.status === status) throw ApiError.conflict(`Ticket is already ${status.replace(/_/g, ' ')}`);
  move(ticket, platformUser._id, status, note);
  if (!ticket.firstResponseAt && status !== 'open') ticket.firstResponseAt = new Date();
  ticket.awaiting = ['resolved', 'closed'].includes(status) ? 'none' : status === 'waiting_on_customer' ? 'society' : 'platform';
  ticket.lastActivityAt = new Date();
  await ticket.save();
  await tellSociety(ticket, `${ticket.number} is now ${status.replace(/_/g, ' ')}`, note || ticket.subject);
  return reload(ticket._id);
}

export async function assign(platformUser, id, assignedTo) {
  const ticket = await load({ _id: id });
  const target = assignedTo || platformUser._id;
  if (!(await User.exists({ _id: target, platformRole: 'super_admin', status: 'active' }))) throw ApiError.badRequest('Assignee must be a platform admin');
  ticket.assignedTo = target;
  ticket.history.push({ by: platformUser._id, from: ticket.status, to: ticket.status, note: 'Assigned' });
  await ticket.save();
  return reload(ticket._id);
}

export const platformTeam = () => User.find({ platformRole: 'super_admin', status: 'active' }).select('name email').lean();

// ---------- scheduled ----------
// Emails the platform team once when a ticket misses its first-response SLA.
export async function slaEscalations(now = new Date()) {
  const breached = await SupportTicket.find({ status: { $in: SUPPORT_ACTIVE }, firstResponseAt: null, slaDueAt: { $lt: now }, slaEscalatedAt: null }).limit(500).lean();
  for (const t of breached) {
    // eslint-disable-next-line no-await-in-loop
    await tellPlatform(t, `SLA breached (${t.priority}): ${t.subject}`, `No first response yet. It was due ${t.slaDueAt.toISOString()}.`);
  }
  if (breached.length) await SupportTicket.updateMany({ _id: { $in: breached.map((t) => t._id) } }, { slaEscalatedAt: now });
  return { escalated: breached.length };
}
