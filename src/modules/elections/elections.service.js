import Election from './election.model.js';
import Nomination from './nomination.model.js';
import Ballot from './ballot.model.js';
import VoteReceipt from './voteReceipt.model.js';
import VoteCode from './voteCode.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import { paginate } from '../../common/utils/pagination.js';
import { numericCode, randomCode, sha256 } from '../../common/utils/codes.js';
import { nextNumber } from '../counter/counter.service.js';
import * as audit from '../audit/audit.service.js';
import * as notices from '../notices/notices.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const LIVE_NOMINATION = ['pending_acceptance', 'accepted', 'approved'];

// ---- access & eligibility ----

// Admins always run elections; a designated returning officer may run that one election.
const isOfficer = (ctx, election) => ctx.role === ROLES.ADMIN || (election.officer && String(election.officer) === String(ctx.userId));

function assertOfficer(ctx, election) {
  if (!isOfficer(ctx, election)) throw ApiError.forbidden('Only the election officer can do this');
}

// Who is voting, expressed as the key that must be unique per election.
export function voterIdentity(ctx, election) {
  if (ctx.role !== ROLES.RESIDENT || !ctx.unitId) return { eligible: false, reason: 'Only residents of a flat can vote. Switch to your home to vote.' };
  if (election.eligibility !== 'unit_any' && ctx.user?.residentType !== 'owner') return { eligible: false, reason: 'Only flat owners can vote in this election' };
  const voterKey = election.eligibility === 'member' ? `user:${ctx.userId}` : `unit:${ctx.unitId}`;
  return { eligible: true, voterKey };
}

function candidateFilter(societyId, eligibility) {
  const filter = { society: societyId, role: ROLES.RESIDENT, status: 'active', unit: { $ne: null } };
  if (eligibility !== 'unit_any') filter.residentType = 'owner';
  return filter;
}

async function countEligible(societyId, eligibility) {
  const field = eligibility === 'member' ? 'user' : 'unit';
  return (await Membership.distinct(field, candidateFilter(societyId, eligibility))).length;
}

function windowState(start, end, now = new Date()) {
  if (start && now < new Date(start)) return 'not_started';
  if (end && now > new Date(end)) return 'ended';
  return 'open';
}

// ---- loading & presenting ----

async function load(ctx, id) {
  const filter = { _id: id, society: ctx.societyId };
  const election = await Election.findOne(filter);
  if (!election || (election.status === 'draft' && !isOfficer(ctx, election))) throw ApiError.notFound('Election not found');
  return election;
}

function log(election, ctx, action, note) {
  election.audit.push({ by: ctx.userId || undefined, action, note });
}

async function present(ctx, doc) {
  const e = doc.toObject ? doc.toObject() : doc;
  const officer = isOfficer(ctx, e);
  const who = voterIdentity(ctx, e);
  const [hasVoted, votesCast] = await Promise.all([
    who.eligible ? VoteReceipt.exists({ election: e._id, voterKey: who.voterKey }) : null,
    VoteReceipt.countDocuments({ election: e._id }),
  ]);
  const finished = ['closed', 'published'].includes(e.status);
  // Results stay sealed until voting closes; members see them once published.
  const showResults = e.status === 'published' || (e.status === 'closed' && officer);
  return {
    ...e,
    results: showResults ? e.results : undefined,
    audit: officer ? e.audit : undefined,
    turnout: officer || finished ? { votesCast, eligible: e.eligibleCount ?? null } : undefined,
    isOfficer: officer,
    nominationWindow: windowState(e.nominationStart, e.nominationEnd),
    votingWindow: windowState(e.votingStart, e.votingEnd),
    me: { eligible: who.eligible, reason: who.reason, hasVoted: Boolean(hasVoted) },
  };
}

// ---- elections ----

export async function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (ctx.role !== ROLES.ADMIN) filter.$or = [{ status: { $ne: 'draft' } }, { officer: ctx.userId }];
  if (filters.status) filter.status = filters.status;
  const result = await paginate(Election, filter, pagination, { select: '-audit -results' });
  result.items = await Promise.all(result.items.map((e) => present(ctx, e)));
  return result;
}

export async function getById(ctx, id) {
  return present(ctx, await load(ctx, id));
}

function checkDates(d) {
  if (d.nominationStart && d.nominationEnd && d.nominationEnd <= d.nominationStart) throw ApiError.badRequest('Nomination end must be after its start');
  if (d.votingStart && d.votingEnd && d.votingEnd <= d.votingStart) throw ApiError.badRequest('Voting end must be after its start');
  if (d.nominationEnd && d.votingStart && d.votingStart < d.nominationEnd) throw ApiError.badRequest('Voting cannot start before nominations close');
}

async function officerMembership(ctx, officer) {
  if (!officer) return undefined;
  const m = await Membership.findOne({ user: officer, society: ctx.societyId, status: 'active' }).lean();
  if (!m) throw ApiError.badRequest('The election officer must be an active member');
  return officer;
}

export async function create(ctx, data) {
  checkDates(data);
  const election = new Election({
    ...data,
    officer: await officerMembership(ctx, data.officer),
    society: ctx.societyId,
    number: await nextNumber(ctx.societyId, 'election', 'ELN'),
    createdBy: ctx.userId,
  });
  log(election, ctx, 'created');
  await election.save();
  audit.record(ctx, 'election.created', 'Election', election._id, { title: election.title });
  return present(ctx, election);
}

export async function update(ctx, id, data) {
  const election = await load(ctx, id);
  assertOfficer(ctx, election);
  if (['voting', 'closed', 'published', 'cancelled'].includes(election.status)) throw ApiError.conflict('The election can no longer be edited');
  if (data.positions && election.status !== 'draft') throw ApiError.conflict('Positions are fixed once nominations open');
  if (data.eligibility && election.status !== 'draft') throw ApiError.conflict('Eligibility is fixed once nominations open');
  if (data.officer !== undefined && ctx.role !== ROLES.ADMIN) throw ApiError.forbidden('Only an admin can change the election officer');
  if (data.officer) data.officer = await officerMembership(ctx, data.officer);
  Object.assign(election, data);
  checkDates(election);
  log(election, ctx, 'updated', Object.keys(data).join(', '));
  await election.save();
  return present(ctx, election);
}

async function notifyElectorate(ctx, election, payload) {
  const ms = await Membership.find(candidateFilter(ctx.societyId, election.eligibility)).select('user').lean();
  await notifyUsers(ctx.societyId, ms.map((m) => m.user), { type: 'election', link: `/elections/${election._id}`, channels: ['inapp', 'push', 'email'], ...payload });
}

const TRANSITIONS = {
  'open-nominations': { from: ['draft'], to: 'nominations' },
  'close-nominations': { from: ['nominations'], to: 'scrutiny' },
  'open-voting': { from: ['scrutiny'], to: 'voting' },
  close: { from: ['voting'], to: 'closed' },
  cancel: { from: ['draft', 'nominations', 'scrutiny', 'voting'], to: 'cancelled' },
};

export async function transition(ctx, id, action, { note } = {}) {
  const election = await load(ctx, id);
  assertOfficer(ctx, election);
  return applyTransition(ctx, election, action, note);
}

async function applyTransition(ctx, election, action, note) {
  const t = TRANSITIONS[action];
  if (!t.from.includes(election.status)) throw ApiError.conflict(`Cannot ${action.replace('-', ' ')} while the election is ${election.status}`);

  if (action === 'open-nominations' && !election.positions.length) throw ApiError.badRequest('Add at least one position');
  if (action === 'close-nominations') {
    // Nominations nobody accepted in time lapse.
    await Nomination.updateMany({ election: election._id, status: 'pending_acceptance' }, { status: 'declined' });
  }
  if (action === 'open-voting') {
    const pending = await Nomination.countDocuments({ election: election._id, status: 'accepted' });
    if (pending) throw ApiError.conflict(`${pending} nomination(s) still await scrutiny`);
    const approved = await Nomination.aggregate([{ $match: { election: election._id, status: 'approved' } }, { $group: { _id: '$position', n: { $sum: 1 } } }]);
    const have = new Set(approved.map((a) => String(a._id)));
    const empty = election.positions.filter((p) => !have.has(String(p._id)));
    if (empty.length) throw ApiError.conflict(`No approved candidates for: ${empty.map((p) => p.title).join(', ')}`);
    election.eligibleCount = await countEligible(election.society, election.eligibility);
  }
  if (action === 'close') {
    election.results = await tally(election);
    election.resultsComputedAt = new Date();
    await VoteCode.deleteMany({ election: election._id });
  }

  election.status = t.to;
  log(election, ctx, action, note);
  await election.save();
  audit.record(ctx, `election.${action}`, 'Election', election._id, { note });

  if (action === 'open-nominations') {
    await notifyElectorate(ctx, election, { title: `Nominations open: ${election.title}`, body: `Posts: ${election.positions.map((p) => p.title).join(', ')}` });
  }
  if (action === 'open-voting') {
    await notifyElectorate(ctx, election, { title: `Voting is open: ${election.title}`, body: election.votingEnd ? `Cast your vote before ${election.votingEnd.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : 'Cast your vote in ColonyHub' });
  }
  return present(ctx, election);
}

// ---- results ----

// Counts ballots per candidate. Ties at the last winning seat are flagged, not broken:
// bye-laws usually require a draw of lots or a re-poll, which the officer records afterwards.
export async function tally(election) {
  const [votes, perPosition, nominations] = await Promise.all([
    Ballot.aggregate([
      { $match: { election: election._id } },
      { $unwind: '$selections' },
      { $unwind: '$selections.nominations' },
      { $group: { _id: '$selections.nominations', votes: { $sum: 1 } } },
    ]),
    Ballot.aggregate([
      { $match: { election: election._id } },
      { $unwind: '$selections' },
      { $match: { 'selections.nominations.0': { $exists: true } } },
      { $group: { _id: '$selections.position', ballots: { $sum: 1 } } },
    ]),
    Nomination.find({ election: election._id, status: 'approved' }).lean(),
  ]);
  const voteMap = new Map(votes.map((v) => [String(v._id), v.votes]));
  const ballotMap = new Map(perPosition.map((p) => [String(p._id), p.ballots]));

  return election.positions.map((pos) => {
    const candidates = nominations
      .filter((n) => String(n.position) === String(pos._id))
      .map((n) => ({ nomination: n._id, name: n.candidateName, unitLabel: n.unitLabel, votes: voteMap.get(String(n._id)) || 0 }))
      .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
    const seats = pos.seats;
    let winners = [];
    let tie = false;
    let tiedCandidates = [];
    let tieNote;
    const unopposed = candidates.length <= seats;
    if (unopposed) winners = candidates.map((c) => c.nomination);
    else {
      const cutoff = candidates[seats - 1].votes;
      if (candidates[seats].votes === cutoff) {
        tie = true;
        tiedCandidates = candidates.filter((c) => c.votes === cutoff).map((c) => c.nomination);
        winners = candidates.filter((c) => c.votes > cutoff).map((c) => c.nomination);
        tieNote = `${tiedCandidates.length} candidates are tied on ${cutoff} vote(s) for ${seats - winners.length} remaining seat(s). To be decided as per bye-laws (draw of lots or re-poll).`;
      } else winners = candidates.slice(0, seats).map((c) => c.nomination);
    }
    const won = new Set(winners.map(String));
    return {
      position: pos._id,
      title: pos.title,
      seats,
      ballots: ballotMap.get(String(pos._id)) || 0,
      candidates: candidates.map((c) => ({ ...c, elected: won.has(String(c.nomination)) })),
      winners,
      unopposed,
      tie,
      tiedCandidates,
      tieNote,
    };
  });
}

export async function results(ctx, id) {
  const election = await load(ctx, id);
  if (!['closed', 'published'].includes(election.status)) throw ApiError.conflict('Results are sealed until voting closes');
  if (election.status === 'closed' && !isOfficer(ctx, election)) throw ApiError.conflict('Results will be available once the election officer publishes them');
  const votesCast = await VoteReceipt.countDocuments({ election: election._id });
  return { status: election.status, results: election.results, votesCast, eligible: election.eligibleCount, computedAt: election.resultsComputedAt, publishedAt: election.publishedAt };
}

export async function resolveTie(ctx, id, { position, winners, note }) {
  const election = await load(ctx, id);
  assertOfficer(ctx, election);
  if (election.status !== 'closed') throw ApiError.conflict('Ties are resolved after voting closes and before results are published');
  const r = election.results.find((x) => String(x.position) === String(position));
  if (!r?.tie || r.tieResolution) throw ApiError.badRequest('There is no unresolved tie for this position');
  const open = r.seats - r.winners.length;
  const tied = new Set(r.tiedCandidates.map(String));
  const chosen = [...new Set(winners.map(String))];
  if (chosen.length !== open || chosen.some((w) => !tied.has(w))) throw ApiError.badRequest(`Choose exactly ${open} of the tied candidates`);
  r.winners.push(...chosen);
  r.candidates.forEach((c) => { if (chosen.includes(String(c.nomination))) c.elected = true; });
  r.tieResolution = note;
  election.markModified('results');
  log(election, ctx, 'tie-resolved', `${r.title}: ${note}`);
  await election.save();
  audit.record(ctx, 'election.tie_resolved', 'Election', election._id, { position: r.title, note });
  return present(ctx, election);
}

export async function publish(ctx, id) {
  const election = await load(ctx, id);
  assertOfficer(ctx, election);
  if (election.status !== 'closed') throw ApiError.conflict('Close voting before publishing results');
  const votesCast = await VoteReceipt.countDocuments({ election: election._id });
  const lines = election.results.map((r) => {
    const names = r.candidates.map((c) => `   ${c.elected ? '✔' : ' '} ${c.name}${c.unitLabel ? ` (${c.unitLabel})` : ''} — ${c.votes} vote(s)`).join('\n');
    const tie = r.tie ? `\n   ${r.tieResolution ? `Tie resolved: ${r.tieResolution}` : r.tieNote}` : '';
    return `${r.title}${r.unopposed ? ' (elected unopposed)' : ''}\n${names}${tie}`;
  });
  const notice = await notices.create(ctx, {
    title: `Election results: ${election.title}`,
    body: `Results of ${election.title} (${election.number}).\nVotes cast: ${votesCast}${election.eligibleCount ? ` of ${election.eligibleCount} eligible` : ''}.\n\n${lines.join('\n\n')}`,
    category: 'general',
    audience: { type: 'all' },
    pinned: true,
  });
  election.status = 'published';
  election.publishedAt = new Date();
  election.notice = notice._id;
  log(election, ctx, 'published');
  await election.save();
  audit.record(ctx, 'election.published', 'Election', election._id);
  return present(ctx, election);
}

// ---- nominations ----

const nominationView = (ctx, election, n) => {
  const officer = isOfficer(ctx, election);
  const mine = String(n.candidateUser) === String(ctx.userId) || String(n.nominatedBy) === String(ctx.userId);
  return { ...n, scrutinyNote: officer || mine ? n.scrutinyNote : undefined, isMine: String(n.candidateUser) === String(ctx.userId), nominatedByMe: String(n.nominatedBy) === String(ctx.userId) };
};

export async function listNominations(ctx, id) {
  const election = await load(ctx, id);
  const filter = { election: election._id };
  // Members see the approved slate plus nominations they filed or received.
  if (!isOfficer(ctx, election)) filter.$or = [{ status: 'approved' }, { candidateUser: ctx.userId }, { nominatedBy: ctx.userId }];
  const list = await Nomination.find(filter).sort({ createdAt: 1 }).lean();
  return list.map((n) => nominationView(ctx, election, n));
}

export async function eligibleCandidates(ctx, id) {
  const election = await load(ctx, id);
  const ms = await Membership.find(candidateFilter(ctx.societyId, election.eligibility)).populate('user', 'name').populate('unit', 'label').lean();
  return ms
    .filter((m) => m.user)
    .map((m) => ({ _id: m._id, name: m.user.name, unitLabel: m.unit?.label, isMe: String(m.user._id) === String(ctx.userId) }))
    .sort((a, b) => (a.unitLabel || '').localeCompare(b.unitLabel || ''));
}

export async function nominate(ctx, id, { position, candidate, statement }) {
  const election = await load(ctx, id);
  if (election.status !== 'nominations') throw ApiError.conflict('Nominations are not open');
  const w = windowState(election.nominationStart, election.nominationEnd);
  if (w !== 'open') throw ApiError.conflict(w === 'ended' ? 'The nomination window has closed' : 'The nomination window has not opened yet');
  if (ctx.role !== ROLES.RESIDENT) throw ApiError.forbidden('Only members (residents) can file nominations');
  const pos = election.positions.id(position);
  if (!pos) throw ApiError.badRequest('Unknown position');

  const candidateId = candidate || ctx.user?.membershipId;
  const m = await Membership.findOne({ ...candidateFilter(ctx.societyId, election.eligibility), _id: candidateId }).populate('user', 'name').populate('unit', 'label').lean();
  if (!m?.user) throw ApiError.badRequest(election.eligibility === 'unit_any' ? 'The candidate must be a resident member' : 'The candidate must be a flat owner');
  const self = String(m.user._id) === String(ctx.userId);
  let nomination;
  try {
    nomination = await Nomination.create({
      society: ctx.societyId,
      election: election._id,
      position: pos._id,
      candidate: m._id,
      candidateUser: m.user._id,
      candidateName: m.user.name,
      unitLabel: m.unit?.label,
      nominatedBy: ctx.userId,
      nominatedByName: ctx.user?.name,
      statement,
      status: self ? 'accepted' : 'pending_acceptance',
      acceptedAt: self ? new Date() : undefined,
    });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict(`${m.user.name} is already nominated for ${pos.title}`);
    throw err;
  }
  if (!self) {
    await notifyUsers(ctx.societyId, [m.user._id], {
      type: 'election',
      title: `You have been nominated for ${pos.title}`,
      body: `${ctx.user?.name || 'A member'} nominated you in ${election.title}. Accept or decline the nomination.`,
      link: `/elections/${election._id}`,
    });
  }
  return nominationView(ctx, election, nomination.toObject());
}

async function loadNomination(election, nid) {
  const n = await Nomination.findOne({ _id: nid, election: election._id });
  if (!n) throw ApiError.notFound('Nomination not found');
  return n;
}

export async function respondNomination(ctx, id, nid, accept) {
  const election = await load(ctx, id);
  if (election.status !== 'nominations') throw ApiError.conflict('Nominations are closed');
  const n = await loadNomination(election, nid);
  if (String(n.candidateUser) !== String(ctx.userId)) throw ApiError.forbidden('Only the nominee can respond to this nomination');
  if (n.status !== 'pending_acceptance') throw ApiError.conflict('This nomination has already been answered');
  n.status = accept ? 'accepted' : 'declined';
  if (accept) n.acceptedAt = new Date();
  await n.save();
  return nominationView(ctx, election, n.toObject());
}

export async function withdrawNomination(ctx, id, nid) {
  const election = await load(ctx, id);
  if (!['nominations', 'scrutiny'].includes(election.status)) throw ApiError.conflict('Nominations can be withdrawn only before voting opens');
  const n = await loadNomination(election, nid);
  const allowed = [String(n.candidateUser), String(n.nominatedBy)].includes(String(ctx.userId));
  if (!allowed) throw ApiError.forbidden('Only the nominee or proposer can withdraw this nomination');
  if (!LIVE_NOMINATION.includes(n.status)) throw ApiError.conflict('This nomination is no longer active');
  n.status = 'withdrawn';
  await n.save();
  return nominationView(ctx, election, n.toObject());
}

export async function scrutinize(ctx, id, nid, { decision, note }) {
  const election = await load(ctx, id);
  assertOfficer(ctx, election);
  if (!['nominations', 'scrutiny'].includes(election.status)) throw ApiError.conflict('Scrutiny happens before voting opens');
  const n = await loadNomination(election, nid);
  if (!['accepted', 'approved', 'rejected'].includes(n.status)) throw ApiError.conflict('Only nominations accepted by the nominee can be scrutinised');
  if (decision === 'reject' && !note) throw ApiError.badRequest('Give a reason for rejecting the nomination');
  n.status = decision === 'approve' ? 'approved' : 'rejected';
  n.scrutinyNote = note;
  n.scrutinizedBy = ctx.userId;
  n.scrutinizedAt = new Date();
  await n.save();
  log(election, ctx, `nomination-${n.status}`, `${n.candidateName}${note ? `: ${note}` : ''}`);
  await election.save();
  await notifyUsers(ctx.societyId, [n.candidateUser], {
    type: 'election',
    title: `Your nomination was ${n.status}`,
    body: note || election.title,
    link: `/elections/${election._id}`,
  });
  return nominationView(ctx, election, n.toObject());
}

// ---- voting ----

function assertVotingOpen(election) {
  if (election.status !== 'voting') throw ApiError.conflict('Voting is not open');
  const w = windowState(election.votingStart, election.votingEnd);
  if (w !== 'open') throw ApiError.conflict(w === 'ended' ? 'Voting has ended' : 'Voting has not started yet');
}

const codeHash = (election, user, code) => sha256(`${election}:${user}:${code}`);

export async function requestVoteCode(ctx, id) {
  const election = await load(ctx, id);
  assertVotingOpen(election);
  const who = voterIdentity(ctx, election);
  if (!who.eligible) throw ApiError.forbidden(who.reason);
  if (await VoteReceipt.exists({ election: election._id, voterKey: who.voterKey })) {
    throw ApiError.conflict(election.eligibility === 'member' ? 'You have already voted' : 'A vote has already been cast for your flat');
  }
  const code = numericCode(6);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await VoteCode.findOneAndUpdate(
    { election: election._id, user: ctx.userId },
    { codeHash: codeHash(election._id, ctx.userId, code), attempts: 0, expiresAt },
    { upsert: true, returnDocument: 'after' },
  );
  return { code, expiresAt };
}

function checkSelections(election, approved, selections) {
  const byPosition = new Map();
  for (const s of selections) {
    const pos = election.positions.id(s.position);
    if (!pos) throw ApiError.badRequest('Unknown position on the ballot');
    if (byPosition.has(String(pos._id))) throw ApiError.badRequest(`${pos.title} appears twice on the ballot`);
    const picks = [...new Set(s.nominations.map(String))];
    if (picks.length !== s.nominations.length) throw ApiError.badRequest(`Each candidate can get only one vote for ${pos.title}`);
    if (picks.length > pos.seats) throw ApiError.badRequest(`Choose at most ${pos.seats} candidate(s) for ${pos.title}`);
    for (const nid of picks) {
      const n = approved.get(nid);
      if (!n || String(n.position) !== String(pos._id)) throw ApiError.badRequest(`Invalid candidate for ${pos.title}`);
    }
    byPosition.set(String(pos._id), { position: pos._id, nominations: picks });
  }
  const out = [...byPosition.values()];
  if (!out.some((s) => s.nominations.length)) throw ApiError.badRequest('Choose at least one candidate');
  return out;
}

export async function castVote(ctx, id, { code, selections }) {
  const election = await load(ctx, id);
  assertVotingOpen(election);
  const who = voterIdentity(ctx, election);
  if (!who.eligible) throw ApiError.forbidden(who.reason);

  const approved = new Map((await Nomination.find({ election: election._id, status: 'approved' }).lean()).map((n) => [String(n._id), n]));
  const clean = checkSelections(election, approved, selections);

  const vc = await VoteCode.findOne({ election: election._id, user: ctx.userId });
  if (!vc || vc.expiresAt < new Date()) throw ApiError.badRequest('Your confirmation code has expired. Request a new one.');
  if (vc.attempts >= MAX_CODE_ATTEMPTS) throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Request a new one.');
  if (vc.codeHash !== codeHash(election._id, ctx.userId, code)) {
    await VoteCode.updateOne({ _id: vc._id }, { $inc: { attempts: 1 } });
    throw ApiError.badRequest('The confirmation code is incorrect');
  }
  await VoteCode.deleteOne({ _id: vc._id });

  // The unique receipt is the double-vote guard; the ballot is written only after it succeeds.
  let receipt;
  try {
    receipt = await VoteReceipt.create({ society: ctx.societyId, election: election._id, voterKey: who.voterKey, user: ctx.userId, unit: ctx.unitId || undefined });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict(election.eligibility === 'member' ? 'You have already voted' : 'A vote has already been cast for your flat');
    throw err;
  }
  const tracker = randomCode(10);
  try {
    await Ballot.create({ society: ctx.societyId, election: election._id, selections: clean, trackerHash: sha256(`${election._id}:${tracker}`) });
  } catch (err) {
    await VoteReceipt.deleteOne({ _id: receipt._id });
    throw err;
  }
  await Election.updateOne({ _id: election._id }, { $inc: { ballotsCast: 1 } });
  return { voted: true, castAt: receipt.castAt, tracker };
}

// A voter can confirm their ballot is in the count with the tracker shown after voting.
export async function verifyBallot(ctx, id, tracker) {
  const election = await load(ctx, id);
  const found = await Ballot.exists({ election: election._id, trackerHash: sha256(`${election._id}:${tracker.trim().toUpperCase()}`) });
  return { found: Boolean(found) };
}

// Officer view of who has voted (participation only, never choices).
export async function turnout(ctx, id) {
  const election = await load(ctx, id);
  assertOfficer(ctx, election);
  const receipts = await VoteReceipt.find({ election: election._id }).populate('unit', 'label').populate('user', 'name').sort({ castAt: 1 }).lean();
  return {
    eligible: election.eligibleCount ?? (await countEligible(ctx.societyId, election.eligibility)),
    votesCast: receipts.length,
    voters: receipts.map((r) => ({ unitLabel: r.unit?.label, name: r.user?.name, castAt: r.castAt })),
  };
}

// Scheduler: close voting whose window has ended, so results are computed on time.
export async function autoClose(now = new Date()) {
  const due = await Election.find({ status: 'voting', votingEnd: { $lt: now } });
  for (const e of due) {
    // eslint-disable-next-line no-await-in-loop
    await applyTransition({ societyId: e.society, userId: null, role: ROLES.ADMIN, ip: 'scheduler' }, e, 'close', 'Voting window ended').catch(() => {});
  }
  return { closed: due.length };
}
