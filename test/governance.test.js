import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
const PW = 'Password@123';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const plusDays = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const h = (who) => bearer(s[who].accessToken);
const get = (who, path, q) => api.get(`/api/v1${path}`).query(q || {}).set(h(who));
const post = (who, path, body) => api.post(`/api/v1${path}`).set(h(who)).send(body || {});
const patch = (who, path, body) => api.patch(`/api/v1${path}`).set(h(who)).send(body || {});
const upload = async (who, name = 'file.pdf') => (await api.post('/api/v1/uploads').set(h(who)).field('folder', 'documents').attach('file', PDF, name)).body.data._id;
// supertest buffers application/pdf as a Buffer when parse is overridden
const pdf = (who, path) => api.get(`/api/v1${path}`).set(h(who)).buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

before(async () => {
  api = await setup();
  const reg = await api.post('/api/v1/auth/register-society').send({
    society: { name: 'Sunrise Co-operative Housing Society', address: '7 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
    admin: { name: 'Admin Sunrise', email: 'admin@gov.test', password: PW },
  });
  s.admin = reg.body.data;
  const block = await post('admin', '/blocks', { name: 'C' });
  await post('admin', '/units/bulk', { block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 4, areaSqft: 800 });
  const units = (await get('admin', '/units', { limit: 50 })).body.data;
  s.units = units.map((u) => u._id);
  const people = [
    ['r1', 'Ravi Owner', '9811100001', 0, 'owner'],
    ['r1b', 'Rekha CoOwner', '9811100002', 0, 'owner'],
    ['r2', 'Sita Secretary', '9811100003', 1, 'owner'],
    ['r3', 'Tara Tenant', '9811100004', 2, 'tenant'],
    ['r4', 'Prakash President', '9811100005', 3, 'owner'],
  ];
  for (const [key, name, phone, unitIdx, residentType] of people) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post('admin', '/users', { name, email: `${key}@gov.test`, phone, password: PW, role: 'resident', unit: s.units[unitIdx], residentType });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    s[`${key}Membership`] = res.body.data._id;
  }
  await post('admin', '/users', { name: 'Gate Guard', email: 'guard@gov.test', password: PW, role: 'guard' });
  const login = async (identifier) => (await api.post('/api/v1/auth/login').send({ identifier, password: PW })).body.data;
  for (const key of ['r1', 'r1b', 'r2', 'r3', 'r4']) s[key] = await login(`${key}@gov.test`); // eslint-disable-line no-await-in-loop
  s.guard = await login('guard@gov.test');

  const other = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Other Society' }, admin: { name: 'Other Admin', email: 'admin@other.test', password: PW } });
  s.otherAdmin = other.body.data;
});
after(teardown);

describe('committee', () => {
  test('admin seats a committee; office-bearers gain governance rights', async () => {
    const term = await post('admin', '/committee/terms', { name: 'Managing Committee 2026-2031', startDate: '2026-04-01', endDate: '2031-03-31' });
    assert.equal(term.status, 201, JSON.stringify(term.body));
    s.term = term.body.data._id;

    const sec = await post('admin', `/committee/terms/${s.term}/positions`, { membership: s.r2Membership, position: 'secretary', isSignatory: true });
    assert.equal(sec.status, 201, JSON.stringify(sec.body));
    const pres = await post('admin', `/committee/terms/${s.term}/positions`, { membership: s.r4Membership, position: 'president', isSignatory: true });
    assert.equal(pres.status, 201);
    const dup = await post('admin', `/committee/terms/${s.term}/positions`, { membership: s.r1Membership, position: 'secretary' });
    assert.equal(dup.status, 409, 'only one secretary at a time');

    const beforeActive = await get('r2', '/committee/me');
    assert.equal(beforeActive.body.data.canManage, false, 'an upcoming committee grants nothing yet');
    assert.equal((await post('admin', `/committee/terms/${s.term}/activate`)).status, 200);

    assert.equal((await get('r2', '/committee/me')).body.data.canManage, true);
    assert.equal((await get('r1', '/committee/me')).body.data.canManage, false);
    assert.equal((await post('r1', '/committee/terms', { name: 'Coup committee', startDate: '2026-01-01', endDate: '2027-01-01' })).status, 403);
    assert.equal((await post('r2', '/committee/terms', { name: 'Self appointed', startDate: '2026-01-01', endDate: '2027-01-01' })).status, 403, 'office-bearers cannot seat committees');

    const current = await get('r1', '/committee/current');
    assert.equal(current.body.data.positions.length, 2);
    const signers = await get('r1', '/committee/signatories');
    assert.deepEqual(signers.body.data.map((x) => x.name), ['Prakash President', 'Sita Secretary']);
  });
});

describe('meetings', () => {
  test('notice, quorum, attendance, resolutions, action items, minutes approval and PDF', async () => {
    assert.equal((await post('r1', '/meetings', { title: 'AGM', type: 'agm', scheduledAt: new Date().toISOString() })).status, 403);

    const created = await post('r2', '/meetings', {
      title: 'Annual General Meeting 2026',
      type: 'agm',
      scheduledAt: new Date(Date.now() - 3600000).toISOString(),
      venue: 'Clubhouse',
      quorum: { type: 'count', value: 3 },
      agenda: [{ title: 'Adoption of audited accounts' }, { title: 'Appointment of auditor' }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const m = created.body.data;
    s.meeting = m._id;
    assert.equal(m.audience.type, 'owners', 'AGMs default to owners');
    assert.equal((await get('r1', `/meetings/${m._id}`)).status, 404, 'drafts are private to the committee');

    const notice = await post('r2', `/meetings/${m._id}/notice`);
    assert.equal(notice.status, 200, JSON.stringify(notice.body));
    assert.equal(notice.body.data.status, 'scheduled');
    assert.equal(notice.body.data.notice.recipients, 4, 'four owners invited');
    const notes = await get('r1', '/notifications');
    assert.ok(notes.body.data.some((n) => n.type === 'meeting' && n.title.includes('Annual General Meeting')));
    assert.equal((await get('r3', `/meetings/${m._id}`)).status, 404, 'tenants are not invited to an owners AGM');
    assert.equal((await get('r1', '/meetings')).body.data.length, 1);

    // attendance and quorum
    await post('r2', `/meetings/${m._id}/attendance`, { entries: [{ membership: s.r1Membership, mode: 'in_person' }] });
    const early = await post('r2', `/meetings/${m._id}/resolutions`, { title: 'Accounts', text: 'Resolved that the accounts be adopted', votesFor: 1 });
    assert.equal(early.status, 409, 'no resolutions without quorum');
    assert.match(early.body.error.message, /Quorum not met/);
    assert.equal((await post('r2', `/meetings/${m._id}/attendance`, { entries: [{ membership: s.r4Membership, mode: 'proxy' }] })).status, 400, 'proxy needs a holder');
    assert.equal((await post('r2', `/meetings/${m._id}/attendance`, { entries: [{ membership: s.r3Membership, mode: 'in_person' }] })).status, 400, 'non-invitee');
    const att = await post('r2', `/meetings/${m._id}/attendance`, {
      entries: [{ membership: s.r2Membership, mode: 'online' }, { membership: s.r4Membership, mode: 'proxy', proxyHolder: 'Mohan Proxy' }],
    });
    assert.equal(att.status, 200);
    assert.deepEqual(
      { present: att.body.data.quorumState.present, required: att.body.data.quorumState.required, met: att.body.data.quorumState.met },
      { present: 3, required: 3, met: true },
    );
    assert.deepEqual(att.body.data.quorumState.byMode, { in_person: 1, online: 1, proxy: 1 });

    const item = att.body.data.agenda[0]._id;
    const base = { agendaItem: item, title: 'Adoption of accounts', text: 'Resolved that the audited accounts for 2025-26 be adopted', proposedBy: s.r1Membership, secondedBy: s.r2Membership };
    const passed = await post('r2', `/meetings/${m._id}/resolutions`, { ...base, votesFor: 2, votesAgainst: 1 });
    assert.equal(passed.status, 201, JSON.stringify(passed.body));
    assert.equal(passed.body.data.resolutions[0].result, 'passed');
    assert.equal(passed.body.data.resolutions[0].proposedByName, 'Ravi Owner');
    const special = await post('r2', `/meetings/${m._id}/resolutions`, { ...base, title: 'Bye-law amendment', majority: 'two_thirds', votesFor: 2, votesAgainst: 1 });
    assert.equal(special.body.data.resolutions[1].result, 'passed', '2 of 3 meets two-thirds');
    const failed = await post('r2', `/meetings/${m._id}/resolutions`, { ...base, title: 'Repaint', votesFor: 1, votesAgainst: 1, abstain: 1 });
    assert.equal(failed.body.data.resolutions[2].result, 'failed', 'a tie fails');
    assert.equal((await post('r2', `/meetings/${m._id}/resolutions`, { ...base, votesFor: 3, votesAgainst: 1 })).status, 400, 'more votes than members present');
    assert.equal((await post('r2', `/meetings/${m._id}/resolutions`, { ...base, secondedBy: s.r1Membership, votesFor: 1 })).status, 400, 'proposer = seconder');
    assert.equal((await post('r2', `/meetings/${m._id}/resolutions`, { ...base, proposedBy: s.r1bMembership, votesFor: 1 })).status, 400, 'absent proposer');

    // minutes per agenda item
    const mins = await patch('r2', `/meetings/${m._id}/agenda/${item}`, { minutes: 'The treasurer presented the audited accounts. Discussion followed.' });
    assert.equal(mins.status, 200);

    // members don't see the draft record
    const draftView = await get('r1', `/meetings/${m._id}`);
    assert.equal(draftView.body.data.resolutions.length, 0);
    assert.equal(draftView.body.data.agenda[0].minutes, undefined);
    assert.equal((await get('r1', `/meetings/${m._id}/minutes/pdf`)).status, 403);

    // action items
    const ai = await post('r2', `/meetings/${m._id}/action-items`, { title: 'Appoint statutory auditor', owner: s.r1Membership, dueDate: plusDays(30) });
    assert.equal(ai.status, 201);
    const aid = ai.body.data.actionItems[0]._id;
    const mine = await get('r1', '/meetings/action-items');
    assert.equal(mine.body.data.length, 1);
    assert.equal(mine.body.data[0].meeting.number, m.number);
    assert.equal((await patch('r1', `/meetings/${m._id}/action-items/${aid}`, { title: 'Changed' })).status, 403);
    const done = await patch('r1', `/meetings/${m._id}/action-items/${aid}`, { status: 'done', notes: 'Auditor appointed' });
    assert.equal(done.status, 200);
    assert.equal(done.body.data.actionItems[0].status, 'done');
    assert.ok(done.body.data.actionItems[0].completedAt);
    assert.equal((await patch('r3', `/meetings/${m._id}/action-items/${aid}`, { status: 'open' })).status, 404);
    assert.equal((await get('r3', '/meetings/action-items')).body.data.length, 0);

    // attachment
    const up = await upload('r2', 'balance-sheet.pdf');
    const withFile = await post('r2', `/meetings/${m._id}/attachments`, { uploads: [up] });
    assert.equal(withFile.body.data.attachments.length, 1);

    // draft PDF for the committee
    const draftPdf = await pdf('r2', `/meetings/${m._id}/minutes/pdf`);
    assert.equal(draftPdf.status, 200);
    assert.match(draftPdf.headers['content-type'], /application\/pdf/);

    // approval
    const approved = await post('r2', `/meetings/${m._id}/minutes/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.status, 'completed');
    assert.equal(approved.body.data.minutes.status, 'approved');
    assert.equal(approved.body.data.minutes.signatories.length, 2);
    assert.equal((await post('r2', `/meetings/${m._id}/resolutions`, { ...base, votesFor: 2 })).status, 409, 'locked after approval');

    const memberView = await get('r1', `/meetings/${m._id}`);
    assert.equal(memberView.body.data.resolutions.length, 3);
    assert.equal(memberView.body.data.attendance.length, 3);
    const file = await pdf('r1', `/meetings/${m._id}/minutes/pdf`);
    assert.equal(file.status, 200);
    assert.match(file.headers['content-type'], /application\/pdf/);
    assert.equal(file.body.subarray(0, 5).toString(), '%PDF-');
    assert.ok(file.body.length > 1500);
  });

  test('minutes cannot be approved before the meeting happens', async () => {
    const future = await post('admin', '/meetings', { title: 'Committee meeting', type: 'committee', scheduledAt: new Date(Date.now() + 86400000).toISOString(), agenda: [{ title: 'Water tank repair' }] });
    assert.equal(future.body.data.audience.type, 'committee');
    await post('admin', `/meetings/${future.body.data._id}/notice`);
    assert.equal((await post('admin', `/meetings/${future.body.data._id}/minutes/approve`)).status, 409);
    assert.equal((await get('r4', `/meetings/${future.body.data._id}`)).status, 200, 'committee members are invited');
  });
});

describe('elections', () => {
  test('full lifecycle with secret ballot, one vote per unit and sealed results', async () => {
    const created = await post('admin', '/elections', {
      title: 'Committee Election 2026',
      positions: [{ title: 'Chairman', seats: 1 }, { title: 'Committee Members', seats: 2 }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const e = created.body.data;
    assert.equal(e.eligibility, 'unit_owner');
    const [chair, members] = e.positions.map((p) => p._id);
    assert.equal((await get('r1', `/elections/${e._id}`)).status, 404, 'draft hidden');
    assert.equal((await post('r1', `/elections/${e._id}/nominations`, { position: chair })).status, 404);

    assert.equal((await post('r2', `/elections/${e._id}/transition/open-nominations`)).status, 404, 'drafts are invisible to non-officers');
    assert.equal((await post('admin', `/elections/${e._id}/transition/open-nominations`)).status, 200);
    assert.equal((await post('r2', `/elections/${e._id}/transition/close-nominations`)).status, 403, 'committee members are not the election officer');

    const self = await post('r1', `/elections/${e._id}/nominations`, { position: chair, statement: 'Transparent accounts' });
    assert.equal(self.status, 201, JSON.stringify(self.body));
    assert.equal(self.body.data.status, 'accepted');
    assert.equal((await post('r1', `/elections/${e._id}/nominations`, { position: chair })).status, 409, 'duplicate');
    const other = await post('r1', `/elections/${e._id}/nominations`, { position: chair, candidate: s.r4Membership });
    assert.equal(other.body.data.status, 'pending_acceptance');
    assert.equal((await post('r1', `/elections/${e._id}/nominations/${other.body.data._id}/respond`, { accept: true })).status, 403, 'only the nominee accepts');
    assert.equal((await post('r4', `/elections/${e._id}/nominations/${other.body.data._id}/respond`, { accept: true })).body.data.status, 'accepted');
    assert.equal((await post('r3', `/elections/${e._id}/nominations`, { position: members })).status, 400, 'tenants cannot stand');
    assert.equal((await post('r2', `/elections/${e._id}/nominations`, { position: members, candidate: s.r3Membership })).status, 400);
    const n2 = await post('r2', `/elections/${e._id}/nominations`, { position: members });
    const n1b = await post('r1b', `/elections/${e._id}/nominations`, { position: members });
    const n4 = await post('r4', `/elections/${e._id}/nominations`, { position: members });
    const nChairR4 = other.body.data._id;
    const nChairR1 = self.body.data._id;

    assert.equal((await post('admin', `/elections/${e._id}/transition/open-voting`)).status, 409);
    assert.equal((await post('admin', `/elections/${e._id}/transition/close-nominations`)).body.data.status, 'scrutiny');
    assert.equal((await post('admin', `/elections/${e._id}/transition/open-voting`)).status, 409, 'nominations await scrutiny');

    assert.equal((await post('r1', `/elections/${e._id}/nominations/${n2.body.data._id}/scrutiny`, { decision: 'approve' })).status, 403);
    for (const nid of [nChairR1, nChairR4, n2.body.data._id, n4.body.data._id]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await post('admin', `/elections/${e._id}/nominations/${nid}/scrutiny`, { decision: 'approve' })).body.data.status, 'approved');
    }
    assert.equal((await post('admin', `/elections/${e._id}/nominations/${n1b.body.data._id}/scrutiny`, { decision: 'reject' })).status, 400, 'reason needed');
    assert.equal((await post('admin', `/elections/${e._id}/nominations/${n1b.body.data._id}/scrutiny`, { decision: 'reject', note: 'Dues outstanding' })).body.data.status, 'rejected');

    const slate = await get('r3', `/elections/${e._id}/nominations`);
    assert.equal(slate.body.data.length, 4, 'members see the approved slate');

    const open = await post('admin', `/elections/${e._id}/transition/open-voting`);
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.equal(open.body.data.eligibleCount, 3, 'three flats have owners');
    const sealed = await get('admin', `/elections/${e._id}/results`);
    assert.equal(sealed.status, 409, 'results hidden while voting');

    // voting
    assert.equal((await post('r3', `/elections/${e._id}/vote-code`)).status, 403, 'tenants cannot vote');
    const code1 = (await post('r1', `/elections/${e._id}/vote-code`)).body.data.code;
    assert.match(code1, /^\d{6}$/);
    const ballot1 = { selections: [{ position: chair, nominations: [nChairR1] }, { position: members, nominations: [n2.body.data._id, n4.body.data._id] }] };
    const wrong = await post('r1', `/elections/${e._id}/vote`, { ...ballot1, code: code1 === '000000' ? '111111' : '000000' });
    assert.equal(wrong.status, 400);
    assert.equal((await post('r1', `/elections/${e._id}/vote`, { code: code1, selections: [{ position: members, nominations: [n2.body.data._id, n2.body.data._id] }] })).status, 400, 'double vote for one candidate');
    assert.equal((await post('r1', `/elections/${e._id}/vote`, { code: code1, selections: [{ position: chair, nominations: [n1b.body.data._id] }] })).status, 400, 'rejected nominee');
    const cast = await post('r1', `/elections/${e._id}/vote`, { ...ballot1, code: code1 });
    assert.equal(cast.status, 201, JSON.stringify(cast.body));
    s.tracker = cast.body.data.tracker;

    assert.equal((await post('r1', `/elections/${e._id}/vote-code`)).status, 409, 'already voted');
    assert.equal((await post('r1b', `/elections/${e._id}/vote-code`)).status, 409, 'co-owner of the same flat cannot vote again');

    const code2 = (await post('r2', `/elections/${e._id}/vote-code`)).body.data.code;
    // two concurrent submissions with the same code: only one ballot counts
    const twice = await Promise.all([
      post('r2', `/elections/${e._id}/vote`, { code: code2, selections: [{ position: chair, nominations: [nChairR4] }, { position: members, nominations: [n2.body.data._id] }] }),
      post('r2', `/elections/${e._id}/vote`, { code: code2, selections: [{ position: chair, nominations: [nChairR4] }, { position: members, nominations: [n2.body.data._id] }] }),
    ]);
    assert.equal(twice.filter((r) => r.status === 201).length, 1, JSON.stringify(twice.map((r) => r.body)));
    assert.ok([400, 409].includes(twice.find((r) => r.status !== 201).status));
    const code4 = (await post('r4', `/elections/${e._id}/vote-code`)).body.data.code;
    assert.equal((await post('r4', `/elections/${e._id}/vote`, { code: code4, selections: [{ position: members, nominations: [n4.body.data._id] }] })).status, 201);

    const during = await get('admin', `/elections/${e._id}`);
    assert.equal(during.body.data.turnout.votesCast, 3);
    assert.equal(during.body.data.results, undefined);
    assert.equal((await get('r1', `/elections/${e._id}`)).body.data.me.hasVoted, true);
    assert.equal((await get('r1b', `/elections/${e._id}`)).body.data.me.hasVoted, true, 'the flat has voted');

    // secret ballot: ballots carry no voter identity
    const { default: Ballot } = await import('../src/modules/elections/ballot.model.js');
    const { default: Receipt } = await import('../src/modules/elections/voteReceipt.model.js');
    const ballots = await Ballot.find({ election: e._id }).lean();
    assert.equal(ballots.length, 3);
    for (const b of ballots) {
      assert.deepEqual(Object.keys(b).sort(), ['_id', 'election', 'selections', 'society', 'trackerHash']);
      assert.equal(typeof b._id, 'string', 'random id, not a time-ordered ObjectId');
    }
    assert.equal(await Receipt.countDocuments({ election: e._id }), 3);

    // close and results: chairman is a 1-1 tie; members are unopposed (2 candidates, 2 seats)
    assert.equal((await post('r1', `/elections/${e._id}/transition/close`)).status, 403);
    const closed = await post('admin', `/elections/${e._id}/transition/close`);
    assert.equal(closed.body.data.status, 'closed');
    assert.equal((await post('r4', `/elections/${e._id}/vote-code`)).status, 409);
    assert.equal((await get('r1', `/elections/${e._id}/results`)).status, 409, 'members wait for publication');
    const res = await get('admin', `/elections/${e._id}/results`);
    assert.equal(res.status, 200);
    const [chairResult, memberResult] = res.body.data.results;
    assert.equal(chairResult.tie, true);
    assert.equal(chairResult.winners.length, 0);
    assert.equal(chairResult.tiedCandidates.length, 2);
    assert.match(chairResult.tieNote, /bye-laws/);
    assert.deepEqual(chairResult.candidates.map((c) => c.votes), [1, 1]);
    assert.equal(memberResult.unopposed, true);
    assert.deepEqual(memberResult.candidates.map((c) => c.votes).sort(), [2, 2]);

    assert.equal((await post('admin', `/elections/${e._id}/resolve-tie`, { position: chair, winners: [nChairR4, nChairR1], note: 'Draw of lots' })).status, 400);
    const resolved = await post('admin', `/elections/${e._id}/resolve-tie`, { position: chair, winners: [nChairR4], note: 'Decided by draw of lots at the AGM' });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));

    const published = await post('admin', `/elections/${e._id}/publish`);
    assert.equal(published.body.data.status, 'published');
    const notices = await get('r3', '/notices');
    assert.ok(notices.body.data.some((n) => n.title === 'Election results: Committee Election 2026' && n.body.includes('draw of lots')));
    const final = await get('r1', `/elections/${e._id}/results`);
    assert.equal(final.status, 200);
    assert.equal(String(final.body.data.results[0].winners[0]), nChairR4);

    assert.equal((await get('r1', `/elections/${e._id}/verify`, { tracker: s.tracker })).body.data.found, true);
    assert.equal((await get('r1', `/elections/${e._id}/verify`, { tracker: 'NOTATRACKER' })).body.data.found, false);
    const auditTrail = (await get('admin', `/elections/${e._id}`)).body.data.audit.map((a) => a.action);
    for (const step of ['created', 'open-nominations', 'close-nominations', 'open-voting', 'close', 'tie-resolved', 'published']) assert.ok(auditTrail.includes(step), step);
    assert.equal((await get('r1', `/elections/${e._id}`)).body.data.audit, undefined);
  });
});

describe('registers', () => {
  test('share certificates never overlap; transfer moves shares and ceases the transferor', async () => {
    const m1 = await post('admin', '/registers/members', { membership: s.r1Membership, admissionDate: '2020-01-15', entranceFee: 10000 });
    assert.equal(m1.status, 201, JSON.stringify(m1.body));
    assert.equal(m1.body.data.name, 'Ravi Owner');
    assert.equal(m1.body.data.memberNo, 1);
    const m2 = await post('r2', '/registers/members', { membership: s.r4Membership, admissionDate: '2020-01-15' });
    assert.equal(m2.status, 201, 'the secretary keeps the registers');
    assert.equal((await post('r1', '/registers/members', { name: 'Someone', admissionDate: '2020-01-01' })).status, 403);
    s.m1 = m1.body.data._id;
    s.m2 = m2.body.data._id;

    const c1 = await post('admin', '/registers/certificates', { member: s.m1, shareCount: 5, faceValue: 5000, issueDate: '2020-02-01' });
    assert.equal(c1.status, 201, JSON.stringify(c1.body));
    assert.deepEqual([c1.body.data.shareFrom, c1.body.data.shareTo, c1.body.data.certificateNo], [1, 5, 1]);
    const concurrent = await Promise.all([
      post('admin', '/registers/certificates', { member: s.m2, shareCount: 5, faceValue: 5000, issueDate: '2020-02-01' }),
      post('admin', '/registers/certificates', { member: s.m2, shareCount: 3, faceValue: 5000, issueDate: '2020-02-01' }),
    ]);
    const ranges = [[1, 5], ...concurrent.map((r) => [r.body.data.shareFrom, r.body.data.shareTo])].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i += 1) assert.ok(ranges[i][0] > ranges[i - 1][1], `overlap ${JSON.stringify(ranges)}`);
    assert.equal(ranges.at(-1)[1], 13);

    const overlap = await post('admin', '/registers/certificates', { member: s.m2, shareCount: 2, faceValue: 5000, issueDate: '2020-02-01', shareFrom: 4 });
    assert.equal(overlap.status, 409);
    const manual = await post('admin', '/registers/certificates', { member: s.m2, shareCount: 5, faceValue: 5000, issueDate: '2015-01-01', shareFrom: 100 });
    assert.deepEqual([manual.body.data.shareFrom, manual.body.data.shareTo], [100, 104]);
    const next = await post('admin', '/registers/certificates', { member: s.m2, shareCount: 1, faceValue: 5000, issueDate: '2020-02-01' });
    assert.equal(next.body.data.shareFrom, 105, 'auto numbering continues after back-filled ranges');

    const tr = await post('admin', '/registers/transfers', { certificate: c1.body.data._id, newMember: { name: 'Bina Buyer', address: 'Flat C-101' }, date: '2026-09-01', transferFee: 2500000, reason: 'sale' });
    assert.equal(tr.status, 201, JSON.stringify(tr.body));
    assert.equal(tr.body.data.transferorName, 'Ravi Owner');
    assert.equal(tr.body.data.transfereeName, 'Bina Buyer');
    assert.equal(tr.body.data.transferFee, 2500000);
    const cert = await get('admin', `/registers/certificates/${c1.body.data._id}`);
    assert.equal(cert.body.data.member.name, 'Bina Buyer');
    assert.equal(cert.body.data.endorsements.length, 1);
    assert.deepEqual([cert.body.data.shareFrom, cert.body.data.shareTo], [1, 5], 'numbers travel with the certificate');
    const seller = await get('admin', `/registers/members/${s.m1}`);
    assert.equal(seller.body.data.status, 'ceased');
    assert.equal(seller.body.data.sharesHeld, 0);
    assert.equal((await post('admin', '/registers/transfers', { certificate: c1.body.data._id, transferee: tr.body.data.transferee, date: '2026-09-02' })).status, 400, 'same holder');

    const transfers = await get('admin', '/registers/transfers');
    assert.equal(transfers.body.data.length, 1);

    const jform = await get('admin', '/registers/j-form');
    assert.deepEqual(jform.body.data.map((m) => m.name).sort(), ['Bina Buyer', 'Prakash President']);
    const jpdf = await pdf('admin', '/registers/j-form/pdf');
    assert.match(jpdf.headers['content-type'], /application\/pdf/);

    const certPdf = await pdf('admin', `/registers/certificates/${c1.body.data._id}/pdf`);
    assert.equal(certPdf.status, 200);
    assert.match(certPdf.headers['content-type'], /application\/pdf/);
    s.m2cert = concurrent[0].body.data._id;
  });

  test('nomination shares must total 100% and a new nomination revokes the old one', async () => {
    const bad = await post('admin', '/registers/nominations', {
      member: s.m2,
      nominees: [{ name: 'Wife', relation: 'Spouse', sharePercent: 60 }, { name: 'Son', relation: 'Son', sharePercent: 30 }],
      witnesses: [{ name: 'Witness One' }],
      nominationDate: '2026-01-10',
    });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.error.details.some((d) => d.field === 'body.nominees' && /100%/.test(d.message)));
    const good = await post('admin', '/registers/nominations', {
      member: s.m2,
      nominees: [{ name: 'Wife', relation: 'Spouse', sharePercent: 60 }, { name: 'Son', relation: 'Son', sharePercent: 40 }],
      witnesses: [{ name: 'Witness One' }],
      nominationDate: '2026-01-10',
    });
    assert.equal(good.status, 201, JSON.stringify(good.body));
    const second = await post('admin', '/registers/nominations', { member: s.m2, nominees: [{ name: 'Daughter', sharePercent: 100 }], witnesses: [{ name: 'W2' }], nominationDate: '2026-06-10' });
    assert.equal(second.status, 201);
    const list = await get('admin', '/registers/nominations', { member: s.m2 });
    assert.deepEqual(list.body.data.map((n) => n.status).sort(), ['active', 'revoked']);
    assert.equal((await post('admin', '/registers/nominations', { member: s.m2, nominees: [{ name: 'X', sharePercent: 100 }], witnesses: [], nominationDate: '2026-06-10' })).status, 422, 'witness required');
  });

  test('members see only their own register entries', async () => {
    const mine = await get('r4', '/registers/mine');
    assert.equal(mine.body.data.length, 1);
    assert.equal(mine.body.data[0].sharesHeld, 14);
    assert.equal(mine.body.data[0].nominations.length, 2);
    assert.equal((await get('r4', `/registers/certificates/${s.m2cert}/pdf`)).status, 200);
    assert.equal((await get('r3', `/registers/certificates/${s.m2cert}`)).status, 404);
    assert.equal((await get('r3', `/registers/members/${s.m2}`)).status, 404);
    assert.equal((await get('r3', '/registers/members')).status, 403);
    const sellerView = await get('r1', '/registers/mine');
    assert.equal(sellerView.body.data[0].status, 'ceased');
    assert.equal(sellerView.body.data[0].transfers.length, 1);
  });
});

describe('documents', () => {
  test('visibility per role, versioning and download tracking', async () => {
    const folders = await get('r1', '/documents/folders');
    assert.equal(folders.body.data.length, 8);
    const folderId = (name) => folders.body.data.find((f) => f.name === name)._id;
    const mk = async (title, visibility, extra = {}) => {
      const res = await post('admin', '/documents', { folder: folderId('Insurance'), title, visibility, upload: await upload('admin', `${title}.pdf`), tags: ['policy', '2026'], ...extra });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.data;
    };
    const pub = await mk('Building insurance policy', { type: 'all' }, { expiryDate: plusDays(10), remindDaysBefore: 30 });
    const committee = await mk('Legal opinion on redevelopment', { type: 'committee' });
    const admins = await mk('Bank KYC', { type: 'admins' });
    const guards = await mk('Fire drill SOP', { type: 'roles', roles: ['guard'] });
    assert.equal(pub.versions[0].url, undefined, 'file links are never listed');

    const titles = async (who) => (await get(who, '/documents')).body.data.map((d) => d.title).sort();
    assert.deepEqual(await titles('r1'), ['Building insurance policy']);
    assert.deepEqual(await titles('r2'), ['Building insurance policy', 'Legal opinion on redevelopment'], 'committee member');
    assert.deepEqual(await titles('guard'), ['Building insurance policy', 'Fire drill SOP']);
    assert.equal((await titles('admin')).length, 4);
    assert.equal((await get('r1', `/documents/${committee._id}`)).status, 404);
    assert.equal((await get('r1', `/documents/${admins._id}/download`)).status, 404);
    assert.equal((await get('r2', `/documents/${guards._id}`)).status, 404);
    assert.equal((await post('r1', '/documents', { folder: folderId('NOCs'), title: 'Mine', upload: await upload('r1') })).status, 403);

    const v2 = await post('admin', `/documents/${pub._id}/versions`, { upload: await upload('admin', 'policy-renewed.pdf'), note: 'Renewed', expiryDate: plusDays(375) });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.data.currentVersion, 2);
    assert.equal(v2.body.data.versions.length, 2);
    const latest = await get('r1', `/documents/${pub._id}/download`);
    assert.equal(latest.body.data.version, 2);
    assert.equal(latest.body.data.name, 'policy-renewed.pdf');
    const old = await get('r1', `/documents/${pub._id}/download`, { version: 1 });
    assert.equal(old.body.data.version, 1);
    assert.match(old.body.data.url, /\/uploads\//);
    assert.notEqual(old.body.data.url, latest.body.data.url);
    const log = await get('admin', `/documents/${pub._id}/downloads`);
    assert.equal(log.body.data.length, 2);
    assert.equal((await get('admin', `/documents/${pub._id}`)).body.data.downloads, 2);
    assert.equal((await get('r1', `/documents/${pub._id}/downloads`)).status, 403);

    const search = await get('r2', '/documents', { q: 'redevelop' });
    assert.deepEqual(search.body.data.map((d) => d.title), ['Legal opinion on redevelopment']);
    const byTag = await get('r1', '/documents', { tag: 'POLICY' });
    assert.equal(byTag.body.data.length, 1);

    await post('admin', `/documents/${admins._id}/archive`);
    assert.equal((await titles('admin')).length, 3);
  });

  test('expiry reminder job notifies the committee once', async () => {
    const folders = (await get('admin', '/documents/folders')).body.data;
    await post('admin', '/documents', { folder: folders.find((f) => f.name === 'Agreements')._id, title: 'Lift AMC', upload: await upload('admin'), expiryDate: plusDays(5), remindDaysBefore: 15 });
    const { expiryReminders } = await import('../src/modules/documents/documents.service.js');
    const first = await expiryReminders();
    assert.equal(first.reminded, 1, 'only the AMC is within its window');
    assert.equal((await expiryReminders()).reminded, 0, 'not again within a week');
    const notes = await get('r2', '/notifications');
    assert.ok(notes.body.data.some((n) => n.type === 'document' && n.title.startsWith('Lift AMC expires')));
  });
});

describe('requests', () => {
  test('sale NOC workflow with dues hold, info request and PDF letter', async () => {
    const { default: Bill } = await import('../src/modules/billing/bill.model.js');
    const { default: Society } = await import('../src/modules/society/society.model.js');
    const sid = (await Society.findOne({ name: 'Sunrise Co-operative Housing Society' }).lean())._id;
    await Bill.create({ society: sid, unit: s.units[0], period: '2026-09', billNumber: 'BILL-T-1', amount: 150000, total: 150000, paid: 50000, status: 'partial', dueDate: new Date() });

    assert.equal((await post('r3', '/requests', { kind: 'noc', nocType: 'sale' })).status, 403, 'tenants cannot ask for a sale NOC');
    assert.equal((await post('r1', '/requests', { kind: 'noc' })).status, 422);
    const created = await post('r1', '/requests', { kind: 'noc', nocType: 'sale', info: { buyerName: 'Bina Buyer' }, addressedTo: 'The Sub-Registrar, Pune' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data._id;
    assert.equal(created.body.data.status, 'pending');

    const adminView = await get('admin', `/requests/${id}`);
    assert.equal(adminView.body.data.dues.outstanding, 100000);
    assert.equal(adminView.body.data.dues.bills.length, 1);
    assert.equal((await get('r3', `/requests/${id}`)).status, 404);

    const held = await post('admin', `/requests/${id}/approve`, {});
    assert.equal(held.status, 409);
    assert.equal(held.body.error.code, 'DUES_OUTSTANDING');

    await post('admin', `/requests/${id}/comments`, { text: 'Check society share certificate', internal: true });
    const info = await post('r2', `/requests/${id}/request-info`, { note: 'Please attach the draft sale agreement' });
    assert.equal(info.body.data.status, 'info_requested');
    assert.equal((await post('r1', `/requests/${id}/approve`, {})).status, 403);
    const resp = await post('r1', `/requests/${id}/respond`, { text: 'Attached', attachments: [await upload('r1', 'agreement.pdf')] });
    assert.equal(resp.body.data.status, 'pending');
    assert.equal(resp.body.data.comments.some((c) => c.internal), false, 'internal notes are hidden from the resident');

    assert.equal((await get('r1', `/requests/${id}/letter/pdf`)).status, 409, 'no letter before approval');
    const approved = await post('admin', `/requests/${id}/approve`, { acknowledgeDues: true, fees: 'Transfer fee ₹25,000' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.status, 'approved');
    assert.match(approved.body.data.letter.number, /^LTR-/);
    assert.equal(approved.body.data.letter.signatory.name, 'Prakash President');
    assert.match(approved.body.data.letter.body, /Bina Buyer/);
    assert.equal(approved.body.data.duesAtApproval, 100000);

    const letter = await pdf('r1', `/requests/${id}/letter/pdf`);
    assert.equal(letter.status, 200);
    assert.match(letter.headers['content-type'], /application\/pdf/);
    assert.equal(letter.body.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await get('r3', `/requests/${id}/letter/pdf`)).status, 404);
  });

  test('tenant move-in needs the agreement; approval notifies guards', async () => {
    const date = plusDays(2);
    const move = { date, from: '10:00', to: '14:00', liftBooking: true, vehicleNumber: 'MH12AB1234', moversCompany: 'Swift Packers' };
    assert.equal((await post('r3', '/requests', { kind: 'move_in', move })).status, 400, 'agreement required');
    assert.equal((await post('r3', '/requests', { kind: 'move_in', move: { ...move, date: '2020-01-01' }, attachments: [await upload('r3')] })).status, 400, 'past date');
    const created = await post('r3', '/requests', { kind: 'move_in', move, attachments: [await upload('r3', 'rent-agreement.pdf')] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.move.tenancy, 'tenant');

    const approved = await post('r4', `/requests/${created.body.data._id}/approve`, {});
    assert.equal(approved.status, 200, 'no dues hold for moves');
    const guardNotes = await get('guard', '/notifications');
    assert.ok(guardNotes.body.data.some((n) => n.type === 'request' && n.title.includes('Move-in approved')));
    const moves = await get('guard', '/requests/moves', { date });
    assert.equal(moves.body.data.items.length, 1);
    assert.equal(moves.body.data.items[0].move.vehicleNumber, 'MH12AB1234');
    assert.equal((await get('r1', '/requests/moves')).status, 403);
  });

  test('moving-day job reminds guards once', async () => {
    const created = await post('r1', '/requests', { kind: 'move_out', move: { date: today(), from: '08:00', to: '11:00' } });
    await post('admin', `/requests/${created.body.data._id}/approve`, {});
    const { notifyGuardsForToday } = await import('../src/modules/requests/requests.service.js');
    assert.equal((await notifyGuardsForToday()).notified, 1);
    assert.equal((await notifyGuardsForToday()).notified, 0);
    assert.equal((await get('guard', '/requests/moves')).body.data.items.length, 1);
  });

  test('rejection and resident withdrawal', async () => {
    const passport = await post('r3', '/requests', { kind: 'noc', nocType: 'passport', purpose: 'passport application' });
    const rej = await post('admin', `/requests/${passport.body.data._id}/reject`, { reason: 'Tenancy not registered with the police' });
    assert.equal(rej.body.data.status, 'rejected');
    assert.equal((await get('r3', `/requests/${passport.body.data._id}/letter/pdf`)).status, 409);
    const gas = await post('r3', '/requests', { kind: 'noc', nocType: 'gas' });
    assert.equal((await post('r3', `/requests/${gas.body.data._id}/cancel`)).body.data.status, 'cancelled');
    const mine = await get('r3', '/requests');
    assert.equal(mine.body.data.length, 3);
    assert.ok(mine.body.data.every((r) => String(r.raisedBy._id) === String(s.r3.user._id)));
  });
});

describe('tenant isolation', () => {
  test('another society sees none of this society\'s governance data', async () => {
    const o = 'otherAdmin';
    assert.equal((await get(o, `/meetings/${s.meeting}`)).status, 404);
    assert.equal((await get(o, '/meetings')).body.data.length, 0);
    assert.equal((await get(o, '/elections')).body.data.length, 0);
    assert.equal((await get(o, '/documents')).body.data.length, 0);
    assert.equal((await get(o, '/requests')).body.data.length, 0);
    assert.equal((await get(o, '/registers/members')).body.data.length, 0);
    assert.equal((await get(o, `/registers/members/${s.m2}`)).status, 404);
    assert.equal((await get(o, `/registers/certificates/${s.m2cert}/pdf`)).status, 404);
    assert.equal((await get(o, '/committee/current')).body.data, null);
    assert.equal((await post(o, `/committee/terms/${s.term}/positions`, { membership: s.r1Membership, position: 'member' })).status, 404);
    const theirFolders = (await get(o, '/documents/folders')).body.data;
    const up = (await api.post('/api/v1/uploads').set(h(o)).field('folder', 'documents').attach('file', PDF, 'x.pdf')).body.data._id;
    const doc = await post(o, '/documents', { folder: theirFolders[0]._id, title: 'Their bye-laws', upload: up });
    assert.equal(doc.status, 201);
    assert.equal((await get('r1', `/documents/${doc.body.data._id}`)).status, 404);
    const ourFolder = (await get('admin', '/documents/folders')).body.data[0]._id;
    assert.equal((await post(o, '/documents', { folder: ourFolder, title: 'Sneaky', upload: await (async () => (await api.post('/api/v1/uploads').set(h(o)).field('folder', 'documents').attach('file', PDF, 'y.pdf')).body.data._id)() })).status, 400);
  });
});

describe('committee history', () => {
  test('seating a new committee dissolves the old one and its authority', async () => {
    const next = await post('admin', '/committee/terms', { name: 'Interim Committee', startDate: '2026-10-01', endDate: '2027-03-31' });
    await post('admin', `/committee/terms/${next.body.data._id}/positions`, { membership: s.r1Membership, position: 'chairman' });
    assert.equal((await post('admin', `/committee/terms/${next.body.data._id}/activate`)).status, 200);
    const terms = await get('r3', '/committee/terms');
    assert.deepEqual(terms.body.data.map((t) => t.status), ['active', 'dissolved']);
    assert.equal((await post('r2', '/meetings', { title: 'Old secretary meeting', type: 'other', scheduledAt: new Date().toISOString() })).status, 403);
    assert.equal((await get('r1', '/committee/me')).body.data.canManage, true);
    assert.equal((await post(`r1`, `/committee/terms/${s.term}/positions`, { membership: s.r2Membership, position: 'member' })).status, 403);
    assert.equal((await post('admin', `/committee/terms/${s.term}/positions`, { membership: s.r2Membership, position: 'member' })).status, 409, 'history is read-only');
  });
});
