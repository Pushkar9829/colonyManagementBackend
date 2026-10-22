import CommitteeTerm, { POSITION_RANK, SINGLE_HOLDER } from './committeeTerm.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import { localDateString } from '../../common/utils/dates.js';
import { withTransaction } from '../../common/utils/transaction.js';
import * as audit from '../audit/audit.service.js';

// ---- governance access (used by meetings, elections, registers, documents, requests) ----

const activeTerm = (societyId) => CommitteeTerm.findOne({ society: societyId, status: 'active' }).lean();

// Active positions the user holds in the sitting committee.
export async function positionsOf(societyId, userId) {
  if (!userId) return [];
  const term = await activeTerm(societyId);
  if (!term) return [];
  return term.positions.filter((p) => p.active && String(p.user) === String(userId));
}

// Society admins and sitting committee office-bearers run governance.
export async function canManage(ctx) {
  if (ctx.role === ROLES.ADMIN) return true;
  return (await positionsOf(ctx.societyId, ctx.userId)).length > 0;
}

export async function myAccess(ctx) {
  const positions = await positionsOf(ctx.societyId, ctx.userId);
  return {
    canManage: ctx.role === ROLES.ADMIN || positions.length > 0,
    isAdmin: ctx.role === ROLES.ADMIN,
    positions: positions.map((p) => ({ _id: p._id, position: p.position, title: p.title, isSignatory: p.isSignatory })),
  };
}

// Admins plus sitting office-bearers — who gets governance alerts (expiring documents, new requests).
export async function managerUserIds(societyId) {
  const [admins, term] = await Promise.all([
    Membership.find({ society: societyId, role: ROLES.ADMIN, status: 'active' }).select('user').lean(),
    activeTerm(societyId),
  ]);
  const ids = admins.map((m) => String(m.user));
  for (const p of term?.positions || []) if (p.active) ids.push(String(p.user));
  return [...new Set(ids)];
}

export const committeeMembershipIds = async (societyId) => {
  const term = await activeTerm(societyId);
  return (term?.positions || []).filter((p) => p.active).map((p) => p.membership);
};

const positionLabel = (p) => p.title || p.position.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Who signs letters and minutes: flagged signatories, else the main office-bearers.
export async function signatories(societyId) {
  const term = await activeTerm(societyId);
  const active = (term?.positions || []).filter((p) => p.active);
  let chosen = active.filter((p) => p.isSignatory);
  if (!chosen.length) chosen = active.filter((p) => ['chairman', 'president', 'secretary', 'treasurer'].includes(p.position));
  return chosen
    .sort((a, b) => POSITION_RANK[a.position] - POSITION_RANK[b.position])
    .map((p) => ({ name: p.name, position: positionLabel(p) }));
}

// ---- terms ----

const sortPositions = (term) => ({
  ...term,
  positions: [...(term.positions || [])].sort((a, b) => Number(b.active) - Number(a.active) || POSITION_RANK[a.position] - POSITION_RANK[b.position]),
});

async function loadTerm(ctx, id) {
  const term = await CommitteeTerm.findOne({ _id: id, society: ctx.societyId });
  if (!term) throw ApiError.notFound('Committee term not found');
  return term;
}

export async function listTerms(ctx) {
  const terms = await CommitteeTerm.find({ society: ctx.societyId }).lean();
  // active first, then upcoming, then history (newest first)
  const order = { active: 0, upcoming: 1, dissolved: 2 };
  return terms.sort((a, b) => order[a.status] - order[b.status] || b.startDate.localeCompare(a.startDate)).map(sortPositions);
}

export async function current(ctx) {
  const term = await activeTerm(ctx.societyId);
  return term ? sortPositions({ ...term, positions: term.positions.filter((p) => p.active) }) : null;
}

export async function createTerm(ctx, data) {
  if (data.endDate <= data.startDate) throw ApiError.badRequest('End date must be after the start date');
  const term = await CommitteeTerm.create({ ...data, society: ctx.societyId, createdBy: ctx.userId });
  audit.record(ctx, 'committee.term_created', 'CommitteeTerm', term._id, { name: term.name });
  return sortPositions(term.toObject());
}

export async function updateTerm(ctx, id, data) {
  const term = await loadTerm(ctx, id);
  if (term.status === 'dissolved') throw ApiError.conflict('A dissolved committee is part of history and cannot be edited');
  Object.assign(term, data);
  if (term.endDate <= term.startDate) throw ApiError.badRequest('End date must be after the start date');
  await term.save();
  return sortPositions(term.toObject());
}

// Seating a new committee dissolves the sitting one, keeping it as history.
export async function activateTerm(ctx, id) {
  const term = await loadTerm(ctx, id);
  if (term.status !== 'upcoming') throw ApiError.conflict('Only an upcoming committee can be activated');
  await withTransaction(async (session) => {
    await CommitteeTerm.updateMany({ society: ctx.societyId, status: 'active' }, { status: 'dissolved', dissolvedAt: new Date() }, { session });
    await CommitteeTerm.updateOne({ _id: term._id }, { status: 'active', activatedAt: new Date() }, { session });
  });
  audit.record(ctx, 'committee.term_activated', 'CommitteeTerm', term._id, { name: term.name });
  return sortPositions(await CommitteeTerm.findById(term._id).lean());
}

export async function dissolveTerm(ctx, id) {
  const term = await loadTerm(ctx, id);
  if (term.status === 'dissolved') throw ApiError.conflict('Already dissolved');
  term.status = 'dissolved';
  term.dissolvedAt = new Date();
  const today = localDateString();
  for (const p of term.positions) {
    if (p.active) {
      p.active = false;
      p.to = p.to || today;
    }
  }
  await term.save();
  audit.record(ctx, 'committee.term_dissolved', 'CommitteeTerm', term._id, { name: term.name });
  return sortPositions(term.toObject());
}

// ---- positions ----

export async function addPosition(ctx, termId, data) {
  const term = await loadTerm(ctx, termId);
  if (term.status === 'dissolved') throw ApiError.conflict('Cannot change a dissolved committee');
  const m = await Membership.findOne({ _id: data.membership, society: ctx.societyId, status: 'active' }).populate('user', 'name').populate('unit', 'label').lean();
  if (!m?.user) throw ApiError.badRequest('Select an active member of this society');
  const active = term.positions.filter((p) => p.active);
  if (active.some((p) => String(p.user) === String(m.user._id))) throw ApiError.conflict('{name} already holds a position in this committee', { params: { name: m.user.name } });
  if (SINGLE_HOLDER.includes(data.position) && active.some((p) => p.position === data.position)) {
    throw ApiError.conflict('The {position} post is already filled; end that term first', { params: { position: data.position.replace('_', ' ') } });
  }
  term.positions.push({
    ...data,
    membership: m._id,
    user: m.user._id,
    name: m.user.name,
    unitLabel: m.unit?.label,
    from: data.from || (term.status === 'active' ? localDateString() : term.startDate),
  });
  await term.save();
  audit.record(ctx, 'committee.position_added', 'CommitteeTerm', term._id, { position: data.position, member: m.user.name });
  return sortPositions(term.toObject());
}

function findPosition(term, positionId) {
  const p = term.positions.id(positionId);
  if (!p) throw ApiError.notFound('Position not found');
  return p;
}

export async function updatePosition(ctx, termId, positionId, data) {
  const term = await loadTerm(ctx, termId);
  if (term.status === 'dissolved') throw ApiError.conflict('Cannot change a dissolved committee');
  const p = findPosition(term, positionId);
  if (data.position && data.position !== p.position && SINGLE_HOLDER.includes(data.position)
    && term.positions.some((x) => x.active && x.position === data.position && String(x._id) !== String(p._id))) {
    throw ApiError.conflict('That post is already filled');
  }
  Object.assign(p, data);
  await term.save();
  return sortPositions(term.toObject());
}

// Stepping down keeps the record (history) but removes the authority.
export async function endPosition(ctx, termId, positionId, { to, notes }) {
  const term = await loadTerm(ctx, termId);
  const p = findPosition(term, positionId);
  if (!p.active) throw ApiError.conflict('This position has already ended');
  p.active = false;
  p.to = to || localDateString();
  if (notes) p.notes = notes;
  await term.save();
  audit.record(ctx, 'committee.position_ended', 'CommitteeTerm', term._id, { position: p.position, member: p.name });
  return sortPositions(term.toObject());
}

export async function removePosition(ctx, termId, positionId) {
  const term = await loadTerm(ctx, termId);
  if (term.status !== 'upcoming') throw ApiError.conflict('Positions of a seated committee are ended, not deleted, to keep history');
  findPosition(term, positionId).deleteOne();
  await term.save();
  return sortPositions(term.toObject());
}

// ---- from an election ----

// Maps an election post title ("Hon. Secretary", "Committee member") to a committee position key.
export function positionFromTitle(title = '') {
  const t = title.toLowerCase();
  if (/joint\s*secretary/.test(t)) return 'joint_secretary';
  if (/vice/.test(t)) return 'vice_president';
  for (const key of ['chairman', 'president', 'secretary', 'treasurer']) if (t.includes(key)) return key;
  if (/co-?opted/.test(t)) return 'co_opted';
  return 'member';
}

// Seats the winners of a published election as an upcoming committee term. The admin reviews it and
// activates it (which dissolves the sitting committee). Extra seats for a single-holder office become members.
export async function termFromElection(ctx, { election: electionId, name, startDate, endDate, notes }) {
  const Election = (await import('../elections/election.model.js')).default;
  const Nomination = (await import('../elections/nomination.model.js')).default;
  const election = await Election.findOne({ _id: electionId, society: ctx.societyId }).lean();
  if (!election) throw ApiError.notFound('Election not found');
  if (election.status !== 'published') throw ApiError.conflict('Publish the election results first');
  const unresolved = (election.results || []).filter((r) => r.tie && !r.tieResolution);
  if (unresolved.length) throw ApiError.conflict('Resolve the tie for {posts} first', { params: { posts: unresolved.map((r) => r.title).join(', ') } });
  if (await CommitteeTerm.exists({ society: ctx.societyId, 'source.election': election._id })) {
    throw ApiError.conflict('A committee has already been created from this election');
  }

  const nominationIds = (election.results || []).flatMap((r) => r.winners || []);
  const nominations = await Nomination.find({ _id: { $in: nominationIds } }).select('candidate').lean();
  const memberOf = new Map(nominations.map((n) => [String(n._id), n.candidate]));

  const term = await createTerm(ctx, { name, startDate, endDate, notes: notes || `Elected in ${election.title} (${election.number})` });
  await CommitteeTerm.updateOne({ _id: term._id }, { 'source.election': election._id });
  const skipped = [];
  for (const r of election.results || []) {
    const key = positionFromTitle(r.title);
    for (const [i, nid] of (r.winners || []).entries()) {
      const membership = memberOf.get(String(nid));
      // a second winner for a one-person office joins as a member, keeping the elected title
      const position = SINGLE_HOLDER.includes(key) && i > 0 ? 'member' : key;
      try {
        // eslint-disable-next-line no-await-in-loop
        await addPosition(ctx, term._id, { membership, position, title: r.title, isSignatory: ['president', 'chairman', 'secretary', 'treasurer'].includes(position) });
      } catch (err) {
        skipped.push({ title: r.title, reason: err.message });
      }
    }
  }
  audit.record(ctx, 'committee.term_from_election', 'CommitteeTerm', term._id, { election: election.number, skipped: skipped.length });
  return { term: sortPositions(await CommitteeTerm.findById(term._id).lean()), skipped };
}
