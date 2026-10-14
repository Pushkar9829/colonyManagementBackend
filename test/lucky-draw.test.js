import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
const HOUR = 3600 * 1000;
const PASSWORD = 'Password@123';
const at = (ms) => new Date(Date.now() + ms).toISOString();
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const hmac = (k, m) => crypto.createHmac('sha256', k).update(m, 'utf8').digest('hex');

const login = async (identifier) => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password: PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const h = (who) => bearer(s[who].accessToken);
const uid = (who) => String(s[who].user._id);
const notes = async (who) => (await api.get('/api/v1/notifications?limit=100').set(h(who))).body.data;

// people: [key, role, unitIndex, residentType]
async function makeSociety(prefix, name, people) {
  const reg = await api.post('/api/v1/auth/register-society').send({
    society: { name },
    admin: { name: `${prefix} Admin`, email: `admin@${prefix}.test`, password: PASSWORD, designation: 'Secretary' },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const out = { admin: reg.body.data, societyId: reg.body.data.user?.society || null };
  const a = bearer(out.admin.accessToken);
  const block = await api.post('/api/v1/blocks').set(a).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(a).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 6, areaSqft: 900 });
  out.units = (await api.get('/api/v1/units').set(a)).body.data;
  for (const [key, role, unitIndex, residentType] of people) {
    const body = { name: `${key} ${prefix}`, email: `${key}@${prefix}.test`, password: PASSWORD, role };
    if (role === 'resident') Object.assign(body, { unit: out.units[unitIndex]._id, residentType });
    else body.designation = `${key} desk`;
    // eslint-disable-next-line no-await-in-loop
    const res = await api.post('/api/v1/users').set(a).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // eslint-disable-next-line no-await-in-loop
    out[key] = await login(`${key}@${prefix}.test`);
  }
  return out;
}

const drawBody = (over = {}) => ({
  title: 'Diwali Bumper Draw',
  description: 'Free draw for residents',
  terms: 'One prize per person. Prizes cannot be exchanged for cash.',
  prizes: [
    { title: 'Smart TV', quantity: 1, value: '43 inch' },
    { title: 'Air fryer', quantity: 2 },
  ],
  entryOpensAt: at(-60 * 1000),
  entryClosesAt: at(2 * HOUR),
  drawAt: at(3 * HOUR),
  reserves: 2,
  ...over,
});

async function createPublished(over = {}, who = 'admin') {
  const c = await api.post('/api/v1/lucky-draws').set(h(who)).send(drawBody(over));
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const p = await api.post(`/api/v1/lucky-draws/${c.body.data._id}/publish`).set(h(who));
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body.data;
}
const enter = (who, id) => api.post(`/api/v1/lucky-draws/${id}/entry`).set(h(who));

let models;
let service;

before(async () => {
  api = await setup();
  models = {
    Society: (await import('../src/modules/society/society.model.js')).default,
    User: (await import('../src/modules/users/user.model.js')).default,
    Entry: (await import('../src/modules/luckyDraw/luckyDrawEntry.model.js')).default,
  };
  service = await import('../src/modules/luckyDraw/luckyDraw.service.js');
  const A = await makeSociety('ld', 'Lucky Towers', [
    ['o1', 'resident', 0, 'owner'],
    ['o1b', 'resident', 0, 'family'], // same flat as o1
    ['o2', 'resident', 1, 'owner'],
    ['o3', 'resident', 2, 'owner'],
    ['o4', 'resident', 3, 'owner'],
    ['t1', 'resident', 4, 'tenant'],
    ['guard', 'guard'],
    ['staff', 'staff'],
  ]);
  Object.assign(s, A);
  const B = await makeSociety('lb', 'Other Park', [['rb', 'resident', 0, 'owner']]);
  s.adminB = B.admin;
  s.rb = B.rb;
  const C = await makeSociety('lc', 'Free Plan Flats', [['rc', 'resident', 0, 'owner']]);
  s.adminC = C.admin;
  s.rc = C.rc;
  const societyC = await models.Society.findOne({ name: 'Free Plan Flats' });
  await models.Society.updateOne({ _id: societyC._id }, { $set: { plan: { name: 'free', unitLimit: 50 } } });
  s.societyC = String(societyC._id);
  s.societyB = String((await models.Society.findOne({ name: 'Other Park' }))._id);
  const { clearCache } = await import('../src/modules/features/features.service.js');
  clearCache();

  await models.User.create({ name: 'Owner', email: 'owner@ld.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'super_admin' });
  s.owner = await login('owner@ld.test');
});
after(teardown);

describe('feature gate', () => {
  test('a society without the luckyDraw feature is refused; trial includes it', async () => {
    const off = await api.get('/api/v1/lucky-draws').set(h('adminC'));
    assert.equal(off.status, 402);
    assert.equal(off.body.error.code, 'FEATURE_DISABLED');
    assert.equal((await api.get('/api/v1/lucky-draws').set(h('admin'))).status, 200);
    const cat = await api.get('/api/v1/platform/features/catalogue').set(bearer(s.owner.accessToken));
    const f = cat.body.data.features.find((x) => x.key === 'luckyDraw');
    assert.equal(f.label, 'Lucky draws');
    assert.ok(cat.body.data.plans.premium.includes('luckyDraw') && cat.body.data.plans.trial.includes('luckyDraw'));
    assert.ok(!cat.body.data.plans.standard.includes('luckyDraw') && !cat.body.data.plans.basic.includes('luckyDraw'));

    // the platform owner can switch it on for one society
    const on = await api.put(`/api/v1/platform/societies/${s.societyC}/features`).set(bearer(s.owner.accessToken)).send({ overrides: { luckyDraw: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal((await api.get('/api/v1/lucky-draws').set(h('adminC'))).status, 200);
  });
});

describe('creating and publishing', () => {
  test('validation: dates in order, prizes required, quantity bounds', async () => {
    const bad1 = await api.post('/api/v1/lucky-draws').set(h('admin')).send(drawBody({ drawAt: at(HOUR) }));
    assert.equal(bad1.status, 422);
    const bad2 = await api.post('/api/v1/lucky-draws').set(h('admin')).send(drawBody({ prizes: [] }));
    assert.equal(bad2.status, 422);
    const bad3 = await api.post('/api/v1/lucky-draws').set(h('admin')).send(drawBody({ prizes: [{ title: 'TV', quantity: 101 }] }));
    assert.equal(bad3.status, 422);
    const bad4 = await api.post('/api/v1/lucky-draws').set(h('admin')).send(drawBody({ reserves: 11 }));
    assert.equal(bad4.status, 422);
    assert.equal((await api.post('/api/v1/lucky-draws').set(h('o1')).send(drawBody())).status, 403, 'residents cannot create');
  });

  test('draft is hidden from residents; publish seals the seed and notifies eligible members', async () => {
    const c = await api.post('/api/v1/lucky-draws').set(h('admin')).send(drawBody());
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const d = c.body.data;
    assert.match(d.number, /^LD-\d{6}$/);
    assert.equal(d.status, 'draft');
    assert.equal(d.fairness.seedHash, null);
    assert.equal((await api.get(`/api/v1/lucky-draws/${d._id}`).set(h('o1'))).status, 404);
    assert.ok(!(await api.get('/api/v1/lucky-draws').set(h('o1'))).body.data.some((x) => x._id === d._id));

    const edit = await api.patch(`/api/v1/lucky-draws/${d._id}`).set(h('admin')).send({ title: 'Diwali Bumper Draw 2026', reserves: 1 });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.data.reserves, 1);

    const p = await api.post(`/api/v1/lucky-draws/${d._id}/publish`).set(h('admin'));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.data.status, 'open');
    assert.match(p.body.data.fairness.seedHash, /^[0-9a-f]{64}$/);
    assert.equal(p.body.data.fairness.seed, null, 'seed stays secret');
    assert.equal((await api.post(`/api/v1/lucky-draws/${d._id}/publish`).set(h('admin'))).status, 409);
    const locked = await api.patch(`/api/v1/lucky-draws/${d._id}`).set(h('admin')).send({ reserves: 5 });
    assert.equal(locked.status, 409, 'rules are frozen after publishing');

    const view = await api.get(`/api/v1/lucky-draws/${d._id}`).set(h('o1'));
    assert.equal(view.status, 200);
    assert.equal(view.body.data.fairness.seed, null);
    assert.equal(view.body.data.reservesList, undefined, 'reserves hidden from residents');
    assert.equal(view.body.data.eligible, true);
    assert.ok(!JSON.stringify(view.body.data).includes('"seed":"'), 'no seed anywhere');

    assert.ok((await notes('o2')).some((n) => n.type === 'luckyDraw' && n.link === `/lucky-draws/${d._id}`));
    assert.ok(!(await notes('guard')).some((n) => n.type === 'luckyDraw'), 'guards are not eligible');
    s.main = d._id;
  });
});

describe('entering', () => {
  test('resident enters and withdraws; double entry refused', async () => {
    const e = await enter('o1', s.main);
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal(e.body.data.myEntry.status, 'entered');
    assert.equal(e.body.data.entrantCount, 1);
    assert.equal((await enter('o1', s.main)).status, 409);
    const w = await api.delete(`/api/v1/lucky-draws/${s.main}/entry`).set(h('o1'));
    assert.equal(w.status, 200);
    assert.equal(w.body.data.myEntry.status, 'withdrawn');
    assert.equal(w.body.data.entrantCount, 0);
    const again = await enter('o1', s.main);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.myEntry._id, e.body.data.myEntry._id, 'same entry id after re-entering');
  });

  test('staff, guards and admin logins cannot enter', async () => {
    assert.equal((await enter('guard', s.main)).status, 403);
    assert.equal((await enter('staff', s.main)).status, 403);
    assert.equal((await enter('admin', s.main)).status, 403);
  });

  test('per-member draw lets two people of one flat enter', async () => {
    assert.equal((await enter('o1b', s.main)).status, 200);
    for (const who of ['o2', 'o3', 'o4', 't1']) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await enter(who, s.main)).status, 200);
    }
    const list = await api.get(`/api/v1/lucky-draws/${s.main}/entries`).set(h('admin'));
    assert.equal(list.status, 200);
    assert.equal(list.body.meta.total, 6);
    const search = await api.get(`/api/v1/lucky-draws/${s.main}/entries?search=o3`).set(h('admin'));
    assert.equal(search.body.data.length, 1);
    assert.equal((await api.get(`/api/v1/lucky-draws/${s.main}/entries`).set(h('o1'))).status, 403);
  });

  test('per-flat draw: one active entry per flat', async () => {
    const d = await createPublished({ title: 'Flat draw', eligibility: { perFlat: true } });
    assert.equal((await enter('o1', d._id)).status, 200);
    const flatmate = await enter('o1b', d._id);
    assert.equal(flatmate.status, 409);
    assert.match(flatmate.body.error.message, /flat/);
    // after withdrawing, the flatmate can enter, and the first person can't come back
    await api.delete(`/api/v1/lucky-draws/${d._id}/entry`).set(h('o1'));
    assert.equal((await enter('o1b', d._id)).status, 200);
    assert.equal((await enter('o1', d._id)).status, 409);
    // the partial unique index backs the code check
    const entry = await models.Entry.findOne({ draw: d._id, status: 'entered' }).lean();
    await assert.rejects(models.Entry.create({ society: entry.society, draw: d._id, user: s.o1.user._id, unit: entry.unit, perFlat: true }), /E11000/);
  });

  test('audience: tenant refused from an owners-only draw, owner refused from tenants-only', async () => {
    const owners = await createPublished({ title: 'Owners draw', eligibility: { audience: 'owners' } });
    const r = await enter('t1', owners._id);
    assert.equal(r.status, 403);
    assert.match(r.body.error.message, /owners/);
    const view = await api.get(`/api/v1/lucky-draws/${owners._id}`).set(h('t1'));
    assert.equal(view.body.data.eligible, false);
    assert.equal((await enter('o2', owners._id)).status, 200);
    assert.ok(!(await notes('t1')).some((n) => n.link === `/lucky-draws/${owners._id}`), 'tenant not notified');
    const tenants = await createPublished({ title: 'Tenants draw', eligibility: { audience: 'tenants' } });
    assert.equal((await enter('o2', tenants._id)).status, 403);
    assert.equal((await enter('t1', tenants._id)).status, 200);
  });

  test('entries refused before the window opens and after it closes', async () => {
    const later = await createPublished({ title: 'Later draw', entryOpensAt: at(HOUR), entryClosesAt: at(2 * HOUR), drawAt: at(2 * HOUR) });
    assert.equal(later.phase, 'upcoming');
    const early = await enter('o1', later._id);
    assert.equal(early.status, 409);
    assert.match(early.body.error.message, /open/);
    const closed = await createPublished({ title: 'Closing draw' });
    await enter('o1', closed._id);
    assert.equal((await api.post(`/api/v1/lucky-draws/${closed._id}/close`).set(h('admin'))).status, 200);
    assert.equal((await enter('o2', closed._id)).status, 409);
    assert.equal((await api.delete(`/api/v1/lucky-draws/${closed._id}/entry`).set(h('o1'))).status, 409, 'no withdrawing after close');
  });
});

describe('the draw', () => {
  test('run draw needs closed entries; winners = sum of quantities; no duplicates; reserves', async () => {
    assert.equal((await api.post(`/api/v1/lucky-draws/${s.main}/draw`).set(h('admin'))).status, 409, 'still open');
    const c = await api.post(`/api/v1/lucky-draws/${s.main}/close`).set(h('admin'));
    assert.equal(c.status, 200);
    assert.equal(c.body.data.status, 'closed');
    assert.match(c.body.data.fairness.entriesHash, /^[0-9a-f]{64}$/);
    assert.equal(c.body.data.fairness.entryCount, 6);

    const r = await api.post(`/api/v1/lucky-draws/${s.main}/draw`).set(h('admin'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.status, 'drawn');
    const winners = d.results.flatMap((x) => x.winners);
    assert.equal(winners.length, 3, '1 TV + 2 air fryers');
    assert.equal(new Set(winners.map((w) => String(w.user))).size, 3, 'one prize per person');
    assert.equal(d.reservesList.length, 1, 'reserves edited to 1');
    assert.ok(!winners.some((w) => String(w.user) === String(d.reservesList[0].user)));
    assert.match(d.fairness.seed, /^[0-9a-f]{64}$/, 'seed revealed');
    assert.equal(sha(d.fairness.seed), d.fairness.seedHash);
    s.mainResult = d;
    assert.equal((await api.post(`/api/v1/lucky-draws/${s.main}/draw`).set(h('admin'))).status, 409, 'cannot run twice');
  });

  test('verify endpoint lets anyone recompute the same order from the revealed seed', async () => {
    const v = await api.get(`/api/v1/lucky-draws/${s.main}/verify`).set(h('o3'));
    assert.equal(v.status, 200);
    const { seed, seedHash, entryIds, entriesHash, order } = v.body.data;
    assert.equal(sha(seed), seedHash);
    assert.equal(sha([...entryIds].sort().join('\n')), entriesHash);
    const mine = entryIds.map((id) => ({ entryId: id, score: hmac(seed, id) })).sort((a, b) => (a.score < b.score ? -1 : 1));
    assert.deepEqual(order.map((o) => o.entryId), mine.map((o) => o.entryId));
    assert.deepEqual(order.map((o) => o.score), mine.map((o) => o.score));
    // the first three in the order won, in prize order (TV first)
    const tv = s.mainResult.results[0].winners[0];
    assert.equal(String(tv.entry), order[0].entryId);
    assert.equal(order[0].outcome, 'Smart TV');
    assert.equal(order[3].outcome, 'Reserve');
  });

  test('results notify entrants; winners get the "You won" message', async () => {
    const winnerUsers = s.mainResult.results.flatMap((r) => r.winners.map((w) => String(w.user)));
    const keys = ['o1', 'o1b', 'o2', 'o3', 'o4', 't1'];
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      const n = (await notes(k)).filter((x) => x.link === `/lucky-draws/${s.main}`);
      if (winnerUsers.includes(uid(k))) assert.ok(n.some((x) => /^You won/.test(x.title)), k);
      else assert.ok(n.some((x) => /^Results are out/.test(x.title)), k);
    }
    const winnerKey = keys.find((k) => winnerUsers.includes(uid(k)));
    const view = await api.get(`/api/v1/lucky-draws/${s.main}`).set(h(winnerKey));
    assert.equal(view.body.data.myWins.length, 1);
  });

  test('promote next reserve and hand over prizes', async () => {
    const slot = s.mainResult.results[1].winners[0];
    const reserve = s.mainResult.reservesList[0];
    assert.equal((await api.post(`/api/v1/lucky-draws/${s.main}/winners/${slot._id}/promote`).set(h('o1')).send({ reason: 'Moved out' })).status, 403);
    const p = await api.post(`/api/v1/lucky-draws/${s.main}/winners/${slot._id}/promote`).set(h('admin')).send({ reason: 'Moved out of the society' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const fryers = p.body.data.results[1].winners;
    const old = fryers.find((w) => w._id === slot._id);
    assert.equal(old.status, 'replaced');
    assert.equal(old.replacedReason, 'Moved out of the society');
    assert.ok(old.replacedBy);
    const promoted = fryers.find((w) => String(w.user) === String(reserve.user));
    assert.equal(promoted.promotedFrom, slot._id);
    assert.ok(p.body.data.reservesList[0].usedFor);
    assert.equal(fryers.filter((w) => w.status === 'won').length, 2);
    const again = await api.post(`/api/v1/lucky-draws/${s.main}/winners/${fryers.find((w) => w.status === 'won')._id}/promote`).set(h('admin')).send({ reason: 'Another one' });
    assert.equal(again.status, 409, 'no reserves left');

    const tv = p.body.data.results[0].winners[0];
    const ho = await api.post(`/api/v1/lucky-draws/${s.main}/winners/${tv._id}/handover`).set(h('admin')).send({ note: 'Collected at office' });
    assert.equal(ho.status, 200);
    assert.ok(ho.body.data.results[0].winners[0].handedOverAt);
    assert.equal(ho.body.data.results[0].winners[0].handoverNote, 'Collected at office');
    assert.equal((await api.post(`/api/v1/lucky-draws/${s.main}/winners/${tv._id}/handover`).set(h('admin')).send({})).status, 409);
    assert.equal((await api.post(`/api/v1/lucky-draws/${s.main}/winners/${old._id}/handover`).set(h('admin')).send({})).status, 409, 'replaced slot');
    // residents never see replaced slots or the reason
    const view = await api.get(`/api/v1/lucky-draws/${s.main}`).set(h('o4'));
    assert.ok(!view.body.data.results[1].winners.some((w) => w.status === 'replaced'));
    const log = await api.get('/api/v1/audit-logs?entity=LuckyDraw&limit=100').set(h('admin'));
    const actions = log.body.data.map((a) => a.action);
    for (const a of ['luckyDraw.created', 'luckyDraw.published', 'luckyDraw.closed', 'luckyDraw.drawn', 'luckyDraw.reserve_promoted', 'luckyDraw.prize_handed_over']) assert.ok(actions.includes(a), a);
  });

  test('two concurrent runs draw only once', async () => {
    const d = await createPublished({ title: 'Race draw' });
    for (const who of ['o1', 'o2', 'o3']) {
      // eslint-disable-next-line no-await-in-loop
      await enter(who, d._id);
    }
    await api.post(`/api/v1/lucky-draws/${d._id}/close`).set(h('admin'));
    const [a, b] = await Promise.all([
      api.post(`/api/v1/lucky-draws/${d._id}/draw`).set(h('admin')),
      api.post(`/api/v1/lucky-draws/${d._id}/draw`).set(h('admin')),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const all = [];
    for (const k of ['o1', 'o2', 'o3']) {
      // eslint-disable-next-line no-await-in-loop
      all.push(...(await notes(k)).filter((n) => n.link === `/lucky-draws/${d._id}` && /^(You won|Results)/.test(n.title)));
    }
    assert.equal(all.length, 3, 'each entrant told exactly once');
    const final = await api.get(`/api/v1/lucky-draws/${d._id}`).set(h('admin'));
    assert.equal(final.body.data.results.flatMap((r) => r.winners).length, 3, 'capped by entrants (3 prizes, 3 people)');
    assert.equal(final.body.data.reservesList.length, 0);
  });

  test('a draw with no entrants finishes with no winners', async () => {
    const d = await createPublished({ title: 'Empty draw' });
    await api.post(`/api/v1/lucky-draws/${d._id}/close`).set(h('admin'));
    const r = await api.post(`/api/v1/lucky-draws/${d._id}/draw`).set(h('admin'));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'drawn');
    assert.equal(r.body.data.noEntrants, true);
    assert.equal(r.body.data.results.flatMap((x) => x.winners).length, 0);
  });

  test('scheduler job closes entries then draws when the draw time comes', async () => {
    const d = await createPublished({ title: 'Scheduled draw', entryClosesAt: at(HOUR), drawAt: at(2 * HOUR) });
    await enter('o2', d._id);
    await enter('o3', d._id);
    const step1 = await service.closeAndDrawDue(new Date(Date.now() + 1.5 * HOUR));
    assert.ok(step1.closed >= 1);
    let view = await api.get(`/api/v1/lucky-draws/${d._id}`).set(h('admin'));
    assert.equal(view.body.data.status, 'closed');
    const step2 = await service.closeAndDrawDue(new Date(Date.now() + 2.5 * HOUR));
    assert.ok(step2.drawn >= 1);
    view = await api.get(`/api/v1/lucky-draws/${d._id}`).set(h('admin'));
    assert.equal(view.body.data.status, 'drawn');
    assert.equal(view.body.data.drawnBy.name, 'Automatic (scheduled)');
    assert.equal(view.body.data.results.flatMap((r) => r.winners).length, 2);
  });

  test('closing reminder goes once, only to eligible members who have not entered', async () => {
    const d = await createPublished({ title: 'Reminder draw', entryClosesAt: at(20 * HOUR), drawAt: at(21 * HOUR) });
    await enter('o2', d._id);
    const r = await service.closingReminders();
    assert.ok(r.reminded >= 1);
    const titleFor = async (k) => (await notes(k)).filter((n) => n.link === `/lucky-draws/${d._id}` && /^Last day/.test(n.title)).length;
    assert.equal(await titleFor('o3'), 1);
    assert.equal(await titleFor('o2'), 0);
    await service.closingReminders();
    assert.equal(await titleFor('o3'), 1, 'not repeated');
  });
});

describe('cancel, isolation and platform oversight', () => {
  test('cancel notifies entrants; drawn draws cannot be cancelled', async () => {
    const d = await createPublished({ title: 'Cancelled draw' });
    await enter('o4', d._id);
    assert.equal((await api.post(`/api/v1/lucky-draws/${d._id}/cancel`).set(h('admin')).send({})).status, 422, 'reason required');
    const c = await api.post(`/api/v1/lucky-draws/${d._id}/cancel`).set(h('admin')).send({ reason: 'Sponsor withdrew' });
    assert.equal(c.status, 200);
    assert.equal(c.body.data.status, 'cancelled');
    assert.ok((await notes('o4')).some((n) => n.title === 'Cancelled: Cancelled draw' && n.body === 'Sponsor withdrew'));
    assert.equal((await enter('o1', d._id)).status, 409);
    assert.equal((await api.post(`/api/v1/lucky-draws/${s.main}/cancel`).set(h('admin')).send({ reason: 'Too late now' })).status, 409);
  });

  test('other societies cannot see or touch draws', async () => {
    assert.equal((await api.get(`/api/v1/lucky-draws/${s.main}`).set(h('rb'))).status, 404);
    assert.equal((await api.get(`/api/v1/lucky-draws/${s.main}/verify`).set(h('rb'))).status, 404);
    assert.equal((await enter('rb', s.main)).status, 404);
    assert.equal((await api.post(`/api/v1/lucky-draws/${s.main}/close`).set(h('adminB'))).status, 404);
    assert.equal((await api.get('/api/v1/lucky-draws').set(h('rb'))).body.data.length, 0);
  });

  test('platform owner lists draws across societies and cancels one', async () => {
    const p = bearer(s.owner.accessToken);
    const bDraw = await createPublished({ title: 'Society B draw' }, 'adminB');
    await enter('rb', bDraw._id);
    assert.equal((await api.get('/api/v1/platform/lucky-draws').set(h('admin'))).status, 403);
    const all = await api.get('/api/v1/platform/lucky-draws?limit=100').set(p);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const societies = new Set(all.body.data.map((d) => d.society.name));
    assert.ok(societies.has('Lucky Towers') && societies.has('Other Park'));
    const onlyB = await api.get(`/api/v1/platform/lucky-draws?society=${s.societyB}&status=open`).set(p);
    assert.deepEqual(onlyB.body.data.map((d) => d._id), [bDraw._id]);
    assert.equal(onlyB.body.data[0].entrantCount, 1);
    const c = await api.post(`/api/v1/platform/lucky-draws/${bDraw._id}/cancel`).set(p).send({ reason: 'Complaint received: paid entry suspected' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.data.status, 'cancelled');
    assert.ok((await notes('rb')).some((n) => n.title === 'Cancelled: Society B draw'));
    const log = await api.get('/api/v1/audit-logs?entity=LuckyDraw').set(h('adminB'));
    assert.ok(log.body.data.some((a) => a.action === 'platform.luckyDraw_cancelled'));
  });
});

describe('demo seed', () => {
  test('creates an open draw and a verifiable finished draw', async () => {
    const { default: seed } = await import('../scripts/seeds/luckyDraw.js');
    const { default: Membership } = await import('../src/modules/users/membership.model.js');
    const sid = s.admin.user ? (await Membership.findOne({ user: s.admin.user._id }).lean()).society : null;
    const map = { 'admin@demo.test': 'admin', 'resident@demo.test': 'o1', 'neha@demo.test': 't1', 'vikram@demo.test': 'o2', 'anita@demo.test': 'o3', 'karan@demo.test': 'o4', 'priya@demo.test': 'o1b' };
    await seed({
      sid,
      user: async (email) => models.User.findById(s[map[email]].user._id).lean(),
      membership: async (email) => Membership.findOne({ user: s[map[email]].user._id, society: sid }).lean(),
    });
    const list = (await api.get('/api/v1/lucky-draws?limit=100').set(h('o1'))).body.data;
    const diwali = list.find((d) => d.title === 'Diwali Bumper Draw' && d.totalPrizes === 8);
    assert.ok(diwali && diwali.entriesOpen && diwali.entrantCount === 4 && diwali.myEntry);
    const past = list.find((d) => d.title === 'Independence Day Draw');
    assert.equal(past.status, 'drawn');
    const v = (await api.get(`/api/v1/lucky-draws/${past._id}/verify`).set(h('o1'))).body.data;
    assert.equal(v.seedMatches, true);
    assert.equal(v.recomputedEntriesHash, v.entriesHash);
    assert.equal(v.order[0].outcome, 'Bicycle');
  });
});
