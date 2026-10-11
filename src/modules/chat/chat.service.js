import Conversation from './conversation.model.js';
import ChatMessage from './chatMessage.model.js';
import ChatBlock from './chatBlock.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { emitToUser } from '../../realtime/socket.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as directory from '../directory/directory.service.js';
import { memberSummaries, requireMember, sameId } from '../directory/members.js';

// Which roles answer each desk. A guard on duty answers as "Security desk".
export const DESKS = {
  security: { label: 'Security desk', roles: ['guard'] },
  management: { label: 'Management office', roles: ['admin', 'facility_manager'] },
};
const DESK_SIDE = 'desk';

const myDesks = (ctx) => Object.keys(DESKS).filter((d) => DESKS[d].roles.includes(ctx.role));
const isAgentFor = (ctx, desk) => DESKS[desk]?.roles.includes(ctx.role);

// Guards talk to residents through the security desk only, never from a personal account.
const canDirect = (role) => role !== 'guard';

const directKey = (a, b) => `direct:${[String(a), String(b)].sort().join(':')}`;
const deskKey = (desk, memberId) => `desk:${desk}:${memberId}`;

// The viewer's side of a conversation: their user id, or 'desk' for an agent.
function sideOf(ctx, conv) {
  if (conv.participants.some((p) => sameId(p, ctx.userId))) return String(ctx.userId);
  if (conv.kind === 'desk' && isAgentFor(ctx, conv.desk)) return DESK_SIDE;
  return null;
}
const otherSide = (conv, side) => (conv.kind === 'desk' ? (side === DESK_SIDE ? String(conv.participants[0]) : DESK_SIDE) : String(conv.participants.find((p) => String(p) !== side)));

async function deskAgents(societyId, desk) {
  const rows = await Membership.find({ society: societyId, role: { $in: DESKS[desk].roles }, status: 'active' }).select('user').lean();
  return [...new Set(rows.map((r) => String(r.user)))];
}
// The users behind a side ('desk' expands to every agent of that desk).
const usersOfSide = async (conv, side) => (side === DESK_SIDE ? deskAgents(conv.society, conv.desk) : [side]);

async function load(ctx, id) {
  const conv = await Conversation.findOne({ _id: id, society: ctx.societyId }).lean();
  const side = conv && sideOf(ctx, conv);
  if (!side) throw ApiError.notFound('Conversation not found');
  return { conv, side };
}

export async function isBlockedBetween(societyId, a, b) {
  return Boolean(await ChatBlock.exists({ society: societyId, $or: [{ blocker: a, blocked: b }, { blocker: b, blocked: a }] }));
}

async function present(ctx, conv, side, summaries) {
  const other = otherSide(conv, side);
  const base = {
    _id: conv._id,
    kind: conv.kind,
    desk: conv.desk || null,
    lastMessage: conv.lastMessage?.text !== undefined ? { ...conv.lastMessage, mine: conv.lastMessage.asDesk ? side === DESK_SIDE : sameId(conv.lastMessage.sender, ctx.userId) } : null,
    lastMessageAt: conv.lastMessageAt || null,
    unread: conv.unread?.[side] || 0,
    // when the other side last read the thread (for "seen" ticks)
    otherReadAt: conv.readAt?.[other] || null,
    asDesk: side === DESK_SIDE,
  };
  if (conv.kind === 'desk' && side !== DESK_SIDE) return { ...base, title: DESKS[conv.desk].label, counterpart: null };
  const person = summaries.get(other) || { _id: other, name: 'Former member', roles: [], units: [] };
  const title = conv.kind === 'desk' ? `${person.name}${person.units.length ? ` · ${person.units.join(', ')}` : ''}` : person.name;
  return { ...base, title, counterpart: person };
}

async function presentMany(ctx, convs) {
  const ids = [];
  const sides = convs.map((c) => sideOf(ctx, c));
  convs.forEach((c, i) => ids.push(otherSide(c, sides[i])));
  const summaries = await memberSummaries(ctx.societyId, ids.filter((x) => x !== DESK_SIDE));
  const blocked = new Set(
    (await ChatBlock.find({ society: ctx.societyId, blocker: ctx.userId }).select('blocked').lean()).map((b) => String(b.blocked)),
  );
  return Promise.all(
    convs.map(async (c, i) => {
      const out = await present(ctx, c, sides[i], summaries);
      if (c.kind === 'direct') out.blockedByMe = blocked.has(otherSide(c, sides[i]));
      return out;
    }),
  );
}

function scopeFilter(ctx) {
  const or = [{ participants: ctx.userId }];
  const desks = myDesks(ctx);
  if (desks.length) or.push({ kind: 'desk', desk: { $in: desks } });
  return { society: ctx.societyId, $or: or };
}

export async function listConversations(ctx, { page, limit, skip }) {
  // threads without messages only show up for whoever opened them
  const filter = { ...scopeFilter(ctx), $and: [{ $or: [{ lastMessageAt: { $ne: null } }, { createdBy: ctx.userId }] }] };
  const [items, total] = await Promise.all([
    Conversation.find(filter).sort({ lastMessageAt: -1, updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Conversation.countDocuments(filter),
  ]);
  return { items: await presentMany(ctx, items), meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getConversation(ctx, id) {
  const { conv } = await load(ctx, id);
  return (await presentMany(ctx, [conv]))[0];
}

async function findOrCreate(filter, doc) {
  try {
    return await Conversation.findOneAndUpdate(filter, { $setOnInsert: doc }, { upsert: true, returnDocument: 'after' }).lean();
  } catch (err) {
    if (err.code === 11000) return Conversation.findOne(filter).lean(); // concurrent open of the same thread
    throw err;
  }
}

// Opens (or returns) the direct thread with another member of the same society.
export async function openDirect(ctx, userId) {
  if (sameId(userId, ctx.userId)) throw ApiError.badRequest('You cannot message yourself');
  if (!canDirect(ctx.role)) throw ApiError.forbidden('Guards reply to residents through the security desk');
  const memberships = await requireMember(ctx.societyId, userId, 'This person is not a member of your society');
  if (memberships.every((m) => !canDirect(m.role))) throw ApiError.badRequest('Message the security desk to reach the guards');
  const key = directKey(ctx.userId, userId);
  const conv = await findOrCreate(
    { society: ctx.societyId, key },
    { society: ctx.societyId, key, kind: 'direct', participants: [ctx.userId, userId], createdBy: ctx.userId },
  );
  return (await presentMany(ctx, [conv]))[0];
}

// Member opens their thread with a desk; an agent may open a desk thread with a given member.
export async function openDesk(ctx, { desk, member }) {
  if (!DESKS[desk]) throw ApiError.badRequest('Unknown desk');
  let memberId = ctx.userId;
  if (isAgentFor(ctx, desk)) {
    if (!member) throw ApiError.badRequest('Choose the resident to message');
    await requireMember(ctx.societyId, member, 'This person is not a member of your society');
    if (sameId(member, ctx.userId)) throw ApiError.badRequest('You cannot message your own desk');
    memberId = member;
  }
  const key = deskKey(desk, memberId);
  const conv = await findOrCreate(
    { society: ctx.societyId, key },
    { society: ctx.societyId, key, kind: 'desk', desk, participants: [memberId], createdBy: ctx.userId },
  );
  return (await presentMany(ctx, [conv]))[0];
}

function presentMessage(ctx, m, side, summaries) {
  const mine = m.asDesk ? side === DESK_SIDE : sameId(m.sender, ctx.userId);
  const sender = summaries.get(String(m.sender));
  return {
    _id: m._id,
    conversation: m.conversation,
    text: m.text,
    attachments: m.attachments || [],
    context: m.context?.type ? m.context : null,
    asDesk: m.asDesk,
    createdAt: m.createdAt,
    mine,
    sender: { _id: m.sender, name: sender?.name || 'Member' },
  };
}

export async function listMessages(ctx, id, { before, limit = 30 }) {
  const { conv, side } = await load(ctx, id);
  const filter = { society: ctx.societyId, conversation: conv._id };
  if (before) filter.createdAt = { $lt: before };
  const rows = await ChatMessage.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const summaries = await memberSummaries(ctx.societyId, page.map((m) => m.sender));
  return { items: page.map((m) => presentMessage(ctx, m, side, summaries)), meta: { hasMore, limit } };
}

async function broadcast(conv, event, payload, presenter) {
  // Each side gets its own view of the message ("mine" differs per side).
  const sides = conv.kind === 'desk' ? [String(conv.participants[0]), DESK_SIDE] : conv.participants.map(String);
  for (const side of sides) {
    // eslint-disable-next-line no-await-in-loop
    const users = await usersOfSide(conv, side);
    for (const u of users) emitToUser(u, conv.society, event, presenter ? presenter(side, u) : payload);
  }
}

export async function sendMessage(ctx, id, { text = '', attachments: ids, context }) {
  const { conv, side } = await load(ctx, id);
  if (!text.trim() && !ids?.length) throw ApiError.badRequest('Type a message or attach a photo');
  const other = otherSide(conv, side);
  if (conv.kind === 'direct' && (await isBlockedBetween(ctx.societyId, ctx.userId, other))) {
    throw ApiError.forbidden('You can no longer message this person');
  }
  if (conv.kind === 'direct' && !(await Membership.exists({ society: ctx.societyId, user: other, status: 'active' }))) {
    throw ApiError.conflict('This person is no longer a member of the society');
  }
  const attachments = await uploads.resolve(ctx, ids);
  if (attachments.some((a) => !a.mimetype.startsWith('image/'))) throw ApiError.badRequest('Only photos can be sent in chat');

  const asDesk = side === DESK_SIDE;
  const message = await ChatMessage.create({ society: ctx.societyId, conversation: conv._id, sender: ctx.userId, asDesk, text: text.trim(), attachments, context });
  const now = message.createdAt;
  const before = await Conversation.findOneAndUpdate(
    { _id: conv._id },
    {
      $set: {
        lastMessage: { text: message.text, sender: ctx.userId, asDesk, hasAttachment: attachments.length > 0 },
        lastMessageAt: now,
        [`unread.${side}`]: 0,
        [`readAt.${side}`]: now,
      },
      $inc: { [`unread.${other}`]: 1 },
    },
    { returnDocument: 'before' },
  ).lean();

  const summaries = await memberSummaries(ctx.societyId, [ctx.userId]);
  const view = (s) => presentMessage({ ...ctx, userId: s === DESK_SIDE ? null : s }, message.toObject(), s, summaries);
  await broadcast(conv, 'chat:message', null, (s) => view(s));

  // One push per unread burst, not one per message.
  if (!before?.unread?.[other]) {
    const senderName = asDesk ? DESKS[conv.desk].label : summaries.get(String(ctx.userId))?.name || 'New message';
    const recipients = await usersOfSide(conv, other);
    await notifyUsers(ctx.societyId, recipients, {
      type: 'chat',
      title: other === DESK_SIDE ? `${DESKS[conv.desk].label}: message from ${summaries.get(String(ctx.userId))?.name || 'a resident'}` : `Message from ${senderName}`,
      body: message.text ? message.text.slice(0, 120) : 'Sent a photo',
      link: `/messages/${conv._id}`,
    });
  }
  return view(side);
}

export async function markRead(ctx, id) {
  const { conv, side } = await load(ctx, id);
  const now = new Date();
  await Conversation.updateOne({ _id: conv._id }, { $set: { [`unread.${side}`]: 0, [`readAt.${side}`]: now } });
  // let the other side update its "seen" ticks; the reader's other tabs clear their badges
  await broadcast(conv, 'chat:read', { conversation: conv._id, side: side === DESK_SIDE ? 'desk' : 'member', at: now });
  return { read: true };
}

export async function typing(ctx, id) {
  const { conv, side } = await load(ctx, id);
  const other = otherSide(conv, side);
  const name = side === DESK_SIDE ? DESKS[conv.desk].label : (await memberSummaries(ctx.societyId, [ctx.userId])).get(String(ctx.userId))?.name;
  for (const u of await usersOfSide(conv, other)) emitToUser(u, ctx.societyId, 'chat:typing', { conversation: conv._id, name });
  return { ok: true };
}

export async function unreadCount(ctx) {
  const mine = await Conversation.find({ society: ctx.societyId, participants: ctx.userId, [`unread.${ctx.userId}`]: { $gt: 0 } })
    .select(`unread.${ctx.userId}`)
    .lean();
  let total = mine.reduce((sum, c) => sum + (c.unread?.[String(ctx.userId)] || 0), 0);
  const desks = myDesks(ctx);
  if (desks.length) {
    const deskConvs = await Conversation.find({ society: ctx.societyId, kind: 'desk', desk: { $in: desks }, 'unread.desk': { $gt: 0 } }).select('unread.desk').lean();
    total += deskConvs.reduce((sum, c) => sum + (c.unread?.desk || 0), 0);
  }
  return { unread: total };
}

// People and desks the viewer can start a conversation with. Only names and flats — never phone/email.
export async function contacts(ctx, { search }) {
  const desks = Object.entries(DESKS)
    .filter(([key]) => !isAgentFor(ctx, key))
    .map(([key, d]) => ({ desk: key, label: d.label }));
  const re = search ? new RegExp(escapeRegex(search.trim()), 'i') : null;
  let people = [];

  if (myDesks(ctx).length && !canDirect(ctx.role)) {
    // desk agents (guards) look up any resident by name or flat to start a desk thread
    const rows = await Membership.find({ society: ctx.societyId, role: 'resident', status: 'active' }).populate('user', 'name status').populate('unit', 'label').lean();
    const map = new Map();
    for (const m of rows) {
      if (!m.user || m.user.status !== 'active') continue;
      const p = map.get(String(m.user._id)) || { _id: m.user._id, name: m.user.name, units: [], role: 'resident', via: 'desk' };
      if (m.unit?.label) p.units.push(m.unit.label);
      map.set(String(m.user._id), p);
    }
    people = [...map.values()];
  } else {
    // everyone else sees neighbours who listed themselves in the directory, plus committee and staff
    const listed = (await directory.list(ctx, {}, { page: 1, limit: 5000, skip: 0 })).items.map((p) => ({ _id: p._id, name: p.name, units: p.units, role: 'resident' }));
    const { committee, staff } = await directory.contacts(ctx);
    const official = [...committee, ...staff].filter((p) => canDirect(p.role)).map((p) => ({ _id: p._id, name: p.name, units: [], role: p.role, designation: p.designation }));
    const seen = new Set();
    people = [...official, ...listed].filter((p) => (seen.has(String(p._id)) ? false : seen.add(String(p._id))));
  }
  people = people.filter((p) => !sameId(p._id, ctx.userId));
  if (re) people = people.filter((p) => re.test(p.name) || p.units.some((u) => re.test(u)) || (p.designation && re.test(p.designation)));
  people.sort((a, b) => a.name.localeCompare(b.name));
  return { desks, people: people.slice(0, 50) };
}

export async function listBlocks(ctx) {
  const rows = await ChatBlock.find({ society: ctx.societyId, blocker: ctx.userId }).sort({ createdAt: -1 }).lean();
  const summaries = await memberSummaries(ctx.societyId, rows.map((r) => r.blocked));
  return rows.map((r) => ({ user: summaries.get(String(r.blocked)) || { _id: r.blocked, name: 'Former member', units: [] }, at: r.createdAt }));
}

export async function block(ctx, userId) {
  if (sameId(userId, ctx.userId)) throw ApiError.badRequest('You cannot block yourself');
  await requireMember(ctx.societyId, userId);
  await ChatBlock.updateOne(
    { society: ctx.societyId, blocker: ctx.userId, blocked: userId },
    { $setOnInsert: { society: ctx.societyId, blocker: ctx.userId, blocked: userId } },
    { upsert: true },
  );
  return { blocked: true };
}

export async function unblock(ctx, userId) {
  await ChatBlock.deleteOne({ society: ctx.societyId, blocker: ctx.userId, blocked: userId });
  return { blocked: false };
}

// Used by other community modules: "Message seller" opens the thread and sends the first message.
export async function contactAbout(ctx, userId, text, contextRef) {
  const conv = await openDirect(ctx, userId);
  const message = await sendMessage(ctx, conv._id, { text, context: contextRef });
  return { conversation: await getConversation(ctx, conv._id), message };
}
