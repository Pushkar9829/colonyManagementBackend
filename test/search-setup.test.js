import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const V1 = '/api/v1';
const PW = 'Password@123';
const s = {};

const login = async (identifier) => {
  const res = await api.post(`${V1}/auth/login`).send({ identifier, password: PW });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const h = (who) => bearer(s[who].accessToken);
const search = async (who, q) => {
  const res = await api.get(`${V1}/search`).query({ q }).set(h(who));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const group = (data, type) => data.groups.find((g) => g.type === type)?.items || [];
const allIds = (data) => data.groups.flatMap((g) => g.items.map((i) => i.id));
const status = async (who = 'admin') => {
  const res = await api.get(`${V1}/society/setup-status`).set(h(who));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const stepDone = (st, key) => st.steps.find((x) => x.key === key).done;

async function addMember(adminHeaders, key, body) {
  const res = await api.post(`${V1}/users`).set(adminHeaders).send({ password: PW, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  s[key] = await login(body.email);
  return res.body.data;
}

before(async () => {
  api = await setup();
  const reg = await api.post(`${V1}/auth/register-society`).send({ society: { name: 'Search Society' }, admin: { name: 'Sara Admin', email: 'admin@ss.test', password: PW } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  s.admin = reg.body.data;
});
after(teardown);

describe('setup checklist', () => {
  test('a brand-new society starts with nothing done', async () => {
    const st = await status();
    assert.equal(st.total, 8);
    assert.equal(st.done, 0, JSON.stringify(st.steps));
    assert.equal(st.dismissedAt, null);
    for (const step of st.steps) assert.ok(step.key && step.title && step.link.startsWith('/'), JSON.stringify(step));
  });

  test('steps flip to done as the admin creates data', async () => {
    const a = h('admin');
    const block = await api.post(`${V1}/blocks`).set(a).send({ name: 'A' });
    assert.equal(block.status, 201);
    let st = await status();
    assert.ok(stepDone(st, 'blocks'));
    assert.ok(!stepDone(st, 'units'));

    await api.post(`${V1}/units/bulk`).set(a).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 3, areaSqft: 1000 });
    s.units = (await api.get(`${V1}/units`).set(a)).body.data;
    assert.ok(stepDone(await status(), 'units'));

    await addMember(a, 'r1', { name: 'Ravi Kumar', email: 'r1@ss.test', phone: '9822200001', role: 'resident', unit: s.units[0]._id, residentType: 'owner' });
    await addMember(a, 'r2', { name: 'Neha Sharma', email: 'r2@ss.test', phone: '9822200002', role: 'resident', unit: s.units[1]._id, residentType: 'owner' });
    st = await status();
    assert.ok(stepDone(st, 'residents'));
    assert.ok(!stepDone(st, 'staff'));

    assert.ok(!stepDone(st, 'billing'));
    const settings = await api.patch(`${V1}/society/me/settings`).set(a).send({ billing: { fixedAmount: 250000 } });
    assert.equal(settings.status, 200, JSON.stringify(settings.body));
    assert.ok(stepDone(await status(), 'billing'));

    await addMember(a, 'guard', { name: 'Gopal Guard', email: 'guard@ss.test', phone: '9822200003', role: 'guard' });
    await addMember(a, 'fm', { name: 'Farah Manager', email: 'fm@ss.test', phone: '9822200004', role: 'facility_manager' });
    await addMember(a, 'acc', { name: 'Arjun Accounts', email: 'acc@ss.test', phone: '9822200005', role: 'accountant' });
    await addMember(a, 'staff', { name: 'Sunil Plumber', email: 'staff@ss.test', phone: '9822200006', role: 'staff' });
    assert.ok(stepDone(await status(), 'staff'));

    // a scheduled notice is not "published" yet
    await api.post(`${V1}/notices`).set(a).send({ title: 'Later notice', body: 'Soon', publishAt: new Date(Date.now() + 86400000).toISOString() });
    assert.ok(!stepDone(await status(), 'notice'));
    await api.post(`${V1}/notices`).set(a).send({ title: 'Welcome', body: 'Hello residents' });
    assert.ok(stepDone(await status(), 'notice'));

    await api.post(`${V1}/amenities`).set(a).send({ name: 'Clubhouse', capacity: 10, openTime: '06:00', closeTime: '22:00', slotMinutes: 60 });
    assert.ok(stepDone(await status(), 'amenities'));

    const fin = await api.patch(`${V1}/finance/settings`).set(a).send({ autopayEnabled: false });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    st = await status();
    assert.ok(stepDone(st, 'finance'));
    assert.equal(st.done, st.total, JSON.stringify(st.steps));
  });

  test('only the admin may read or dismiss it', async () => {
    for (const who of ['r1', 'acc', 'fm', 'guard']) {
      assert.equal((await api.get(`${V1}/society/setup-status`).set(h(who))).status, 403, who);
      assert.equal((await api.post(`${V1}/society/setup-status/dismiss`).set(h(who))).status, 403, who);
    }
  });

  test('dismiss records the time and it sticks', async () => {
    const res = await api.post(`${V1}/society/setup-status/dismiss`).set(h('admin'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.dismissedAt);
    assert.ok((await status()).dismissedAt);
  });
});

describe('global search', () => {
  before(async () => {
    // complaints: one per resident, one assigned to the plumber
    const c1 = await api.post(`${V1}/complaints`).set(h('r1')).send({ category: 'plumbing', title: 'Kitchen tap leaking' });
    assert.equal(c1.status, 201, JSON.stringify(c1.body));
    s.c1 = c1.body.data;
    const c2 = await api.post(`${V1}/complaints`).set(h('r2')).send({ category: 'plumbing', title: 'Bathroom leak' });
    s.c2 = c2.body.data;
    const assign = await api.post(`${V1}/complaints/${s.c2._id}/assign`).set(h('fm')).send({ assignedTo: s.staff.user._id });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));

    const v1 = await api.post(`${V1}/vehicles`).set(h('r1')).send({ number: 'MH12AB1234', type: 'four_wheeler' });
    assert.equal(v1.status, 201, JSON.stringify(v1.body));
    await api.post(`${V1}/vehicles`).set(h('r2')).send({ number: 'MH12CD5678', type: 'two_wheeler' });

    const gen = await api.post(`${V1}/bills/generate`).set(h('acc')).send({ period: '2026-10' });
    assert.equal(gen.status, 201, JSON.stringify(gen.body));
    s.bills = (await api.get(`${V1}/bills`).set(h('acc'))).body.data;
    s.r2Bill = s.bills.find((b) => b.unit._id === s.units[1]._id);

    const visitor = await api.post(`${V1}/visitors`).set(h('guard')).send({ unit: s.units[0]._id, name: 'Courier Guy', phone: '9933300001', purpose: 'delivery' });
    assert.equal(visitor.status, 201, JSON.stringify(visitor.body));

    // Neha lists herself in the directory but keeps her phone and email hidden
    await api.patch(`${V1}/directory/me`).set(h('r2')).send({ listed: true, showPhone: false, showEmail: false });

    // a second society with look-alike data
    const reg = await api.post(`${V1}/auth/register-society`).send({ society: { name: 'Other Society' }, admin: { name: 'Otto Admin', email: 'admin@os.test', password: PW } });
    s.adminB = reg.body.data;
    const b = h('adminB');
    const blk = await api.post(`${V1}/blocks`).set(b).send({ name: 'A' });
    await api.post(`${V1}/units/bulk`).set(b).send({ block: blk.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 2 });
    s.unitsB = (await api.get(`${V1}/units`).set(b)).body.data;
    await addMember(b, 'rB', { name: 'Ravi Bose', email: 'rb@os.test', phone: '9822200099', role: 'resident', unit: s.unitsB[0]._id, residentType: 'owner' });
    const cB = await api.post(`${V1}/complaints`).set(h('rB')).send({ category: 'plumbing', title: 'Leak in lobby' });
    s.cB = cB.body.data;
  });

  test('admin gets grouped results with links', async () => {
    const units = group(await search('admin', 'A-101'), 'unit');
    assert.equal(units.length, 1);
    assert.equal(units[0].id, s.units[0]._id);
    assert.equal(units[0].link, '/units');

    const people = group(await search('admin', 'ravi'), 'person');
    assert.deepEqual(people.map((p) => p.title), ['Ravi Kumar']);
    assert.match(people[0].subtitle, /r1@ss\.test/);

    assert.equal(group(await search('admin', 'MH12AB'), 'vehicle')[0].title, 'MH12AB1234');
    const tickets = group(await search('admin', 'leak'), 'complaint');
    assert.equal(tickets.length, 2);
    assert.ok(tickets.every((t) => t.link === `/complaints/${t.id}`));
    assert.equal(group(await search('admin', s.r2Bill.billNumber), 'bill')[0].id, s.r2Bill._id);
    assert.equal(group(await search('admin', 'courier'), 'visitor').length, 1);
    // people are findable by phone too
    assert.equal(group(await search('admin', '9822200002'), 'person')[0].title, 'Neha Sharma');
  });

  test('every group is capped at five results', async () => {
    const units = group(await search('admin', 'ss.test'), 'person');
    assert.ok(units.length <= 5);
    assert.equal(units.length, 5, 'seven members match the domain');
  });

  test('accountant sees bills but not tickets or visitors; facility manager the reverse', async () => {
    const acc = await search('acc', 'leak');
    assert.equal(group(acc, 'complaint').length, 0);
    assert.equal(group(await search('acc', s.r2Bill.billNumber), 'bill').length, 1);
    assert.equal(group(await search('acc', 'courier'), 'visitor').length, 0);

    assert.equal(group(await search('fm', 'leak'), 'complaint').length, 2);
    assert.equal(group(await search('fm', s.r2Bill.billNumber), 'bill').length, 0);
    assert.equal(group(await search('fm', 'courier'), 'visitor').length, 1);
  });

  test('guard finds residents by name and flat but never their email or phone', async () => {
    const data = await search('guard', 'neha');
    const people = group(data, 'person');
    assert.equal(people.length, 1);
    assert.equal(people[0].subtitle, s.units[1].label);
    const raw = JSON.stringify(data);
    assert.ok(!raw.includes('r2@ss.test') && !raw.includes('9822200002'), raw);
    // and searching by a phone number or email finds nobody
    assert.equal(group(await search('guard', '9822200002'), 'person').length, 0);
    assert.equal(group(await search('guard', 'r2@ss'), 'person').length, 0);
    // guards do see units, vehicles and recent visitors
    assert.equal(group(await search('guard', 'MH12CD'), 'vehicle').length, 1);
    assert.equal(group(await search('guard', 'courier'), 'visitor').length, 1);
    assert.equal(group(await search('guard', 'A-102'), 'unit').length, 1);
    assert.equal(group(await search('guard', 'leak'), 'complaint').length, 0);
  });

  test('a resident only finds their own tickets, bills and vehicles', async () => {
    const leaks = group(await search('r1', 'leak'), 'complaint');
    assert.deepEqual(leaks.map((c) => c.id), [s.c1._id]);
    assert.equal(group(await search('r1', s.r2Bill.billNumber), 'bill').length, 0);
    const own = s.bills.find((b) => b.unit._id === s.units[0]._id);
    assert.equal(group(await search('r1', own.billNumber), 'bill').length, 1);
    assert.equal(group(await search('r1', 'MH12CD'), 'vehicle').length, 0);
    assert.equal(group(await search('r1', 'MH12AB'), 'vehicle').length, 1);
    assert.equal(group(await search('r1', 'A-102'), 'unit').length, 0);
    assert.equal(group(await search('r1', 'courier'), 'visitor').length, 0);
  });

  test('residents find neighbours through the directory, with its privacy rules', async () => {
    const data = await search('r1', 'neha');
    const people = group(data, 'person');
    assert.equal(people.length, 1);
    assert.equal(people[0].link, '/directory');
    assert.ok(!JSON.stringify(data).includes('9822200002'));
    // Ravi never opted in, so Neha cannot find him
    assert.equal(group(await search('r2', 'ravi'), 'person').length, 0);
  });

  test('staff only see tickets assigned to them', async () => {
    const data = await search('staff', 'leak');
    assert.deepEqual(group(data, 'complaint').map((c) => c.id), [s.c2._id]);
    assert.deepEqual(data.groups.map((g) => g.type), ['complaint']);
  });

  test("another society's data never appears", async () => {
    const mine = await search('admin', 'leak');
    assert.ok(!allIds(mine).includes(s.cB._id));
    assert.ok(!allIds(await search('admin', 'A-101')).includes(s.unitsB[0]._id));
    assert.deepEqual(group(await search('admin', 'ravi'), 'person').map((p) => p.title), ['Ravi Kumar']);

    const theirs = await search('adminB', 'leak');
    assert.deepEqual(group(theirs, 'complaint').map((c) => c.id), [s.cB._id]);
    assert.equal(group(await search('adminB', 'MH12'), 'vehicle').length, 0);
    assert.equal(group(await search('adminB', 'courier'), 'visitor').length, 0);
  });

  test('regex characters are matched literally', async () => {
    for (const q of ['.*', '(((', '[a-', 'a+?', '\\d+', '$where', '^.*$']) {
      const data = await search('admin', q);
      assert.ok(Array.isArray(data.groups), q);
      assert.equal(data.groups.length, 0, `${q}: ${JSON.stringify(data.groups)}`);
    }
  });

  test('query length is validated and auth is required', async () => {
    assert.equal((await api.get(`${V1}/search`).query({ q: 'a' }).set(h('admin'))).status, 422);
    assert.equal((await api.get(`${V1}/search`).query({ q: 'x'.repeat(61) }).set(h('admin'))).status, 422);
    assert.equal((await api.get(`${V1}/search`).set(h('admin'))).status, 422);
    assert.equal((await api.get(`${V1}/search`).query({ q: 'leak' })).status, 401);
  });
});
