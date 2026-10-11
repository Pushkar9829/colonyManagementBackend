import Poll from './poll.model.js';
import PollVote from './pollVote.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { getPagination } from '../../common/utils/pagination.js';
import { audienceFilter, audienceUserIds } from '../../common/utils/audience.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';

const voterKey = (ctx) => (ctx.unitId ? `unit:${ctx.unitId}` : `user:${ctx.userId}`);
const isOpen = (p) => p.status === 'open' && (!p.closesAt || new Date(p.closesAt) > new Date());

function present(poll, myVote) {
  const totalVotes = poll.options.reduce((s, o) => s + o.votes, 0);
  return {
    ...poll,
    status: isOpen(poll) ? 'open' : 'closed',
    totalVotes,
    myVote: myVote ?? null,
    options: poll.options.map((o) => ({ ...o, percent: totalVotes ? Math.round((o.votes / totalVotes) * 100) : 0 })),
  };
}

export async function create(ctx, { options, ...data }) {
  const poll = await Poll.create({ ...data, options: options.map((text) => ({ text })), society: ctx.societyId, createdBy: ctx.userId });
  const recipients = (await audienceUserIds(ctx.societyId, poll.audience)).filter((id) => String(id) !== String(ctx.userId));
  await notifyUsers(ctx.societyId, recipients, { type: 'poll', title: 'New poll', body: poll.question, link: '/polls' });
  audit.record(ctx, 'poll.created', 'Poll', poll._id, { question: poll.question });
  return present(poll.toObject());
}

export async function list(ctx, filters) {
  const { page, limit, skip } = getPagination(filters);
  const filter = { society: ctx.societyId, ...(await audienceFilter(ctx)) };
  const now = new Date();
  if (filters.status === 'open') Object.assign(filter, { status: 'open', $and: [{ $or: [{ closesAt: null }, { closesAt: { $gt: now } }] }] });
  if (filters.status === 'closed') filter.$and = [{ $or: [{ status: 'closed' }, { closesAt: { $lte: now } }] }];

  const [polls, total] = await Promise.all([
    Poll.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('createdBy', 'name').lean(),
    Poll.countDocuments(filter),
  ]);
  const votes = await PollVote.find({ poll: { $in: polls.map((p) => p._id) }, voterKey: voterKey(ctx) }).lean();
  const byPoll = new Map(votes.map((v) => [String(v.poll), v.optionIndex]));
  return { items: polls.map((p) => present(p, byPoll.get(String(p._id)))), meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function vote(ctx, id, optionIndex) {
  const poll = await Poll.findOne({ _id: id, society: ctx.societyId, ...(await audienceFilter(ctx)) }).lean();
  if (!poll) throw ApiError.notFound('Poll not found');
  if (!isOpen(poll)) throw ApiError.conflict('This poll is closed');
  if (optionIndex >= poll.options.length) throw ApiError.badRequest('Invalid option');

  try {
    await PollVote.create({ society: ctx.societyId, poll: poll._id, voterKey: voterKey(ctx), unit: ctx.unitId || undefined, user: ctx.userId, optionIndex });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict(ctx.unitId ? 'Your household has already voted' : 'You have already voted');
    throw err;
  }
  const updated = await Poll.findByIdAndUpdate(poll._id, { $inc: { [`options.${optionIndex}.votes`]: 1 } }, { returnDocument: 'after' }).lean();
  return present(updated, optionIndex);
}

export async function close(ctx, id) {
  const poll = await Poll.findOneAndUpdate({ _id: id, society: ctx.societyId }, { status: 'closed' }, { returnDocument: 'after' }).lean();
  if (!poll) throw ApiError.notFound('Poll not found');
  audit.record(ctx, 'poll.closed', 'Poll', poll._id);
  return present(poll);
}

// Non-anonymous polls let managers see who voted for what.
export async function voters(ctx, id) {
  const poll = await Poll.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!poll) throw ApiError.notFound('Poll not found');
  if (poll.anonymous) throw ApiError.forbidden('This poll is anonymous');
  return PollVote.find({ poll: id }).populate('user', 'name').populate('unit', 'label').select('optionIndex createdAt user unit').lean();
}
