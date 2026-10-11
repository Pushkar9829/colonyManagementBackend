import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
const login = async (identifier) => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password: 'Password@123' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

async function newSociety(name, adminEmail) {
  const reg = await api.post('/api/v1/auth/register-society').send({ society: { name }, admin: { name: `${name} Admin`, email: adminEmail, password: 'Password@123' } });
  const admin = reg.body.data;
  const h = bearer(admin.accessToken);
  const block = await api.post('/api/v1/blocks').set(h).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 3, areaSqft: 1000 });
  const units = (await api.get('/api/v1/units').set(h)).body.data;
  await api.patch('/api/v1/society/me/settings').set(h).send({ billing: { fixedAmount: 100000 } });
  return { admin, code: admin.user.society.code, units };
}

before(async () => {
  api = await setup();
  s.one = await newSociety('Society One', 'admin1@m.test');
  s.two = await newSociety('Society Two', 'admin2@m.test');
});
after(teardown);

describe('one person, many homes', () => {
  test('admin adds an existing account to a second flat without touching its password', async () => {
    const h = bearer(s.one.admin.accessToken);
    const first = await api.post('/api/v1/users').set(h).send({ name: 'Ravi', email: 'ravi@m.test', phone: '9700000001', password: 'Password@123', role: 'resident', unit: s.one.units[0]._id, residentType: 'owner' });
    assert.equal(first.status, 201);
    const second = await api.post('/api/v1/users').set(h).send({ name: 'Ravi', email: 'ravi@m.test', role: 'resident', unit: s.one.units[1]._id, residentType: 'owner' });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.data.user, first.body.data.user, 'same account reused');
    const dup = await api.post('/api/v1/users').set(h).send({ name: 'Ravi', email: 'ravi@m.test', role: 'resident', unit: s.one.units[1]._id, residentType: 'owner' });
    assert.equal(dup.status, 409);
    const noPassword = await api.post('/api/v1/users').set(h).send({ name: 'New', email: 'new@m.test', role: 'guard' });
    assert.equal(noPassword.status, 422, 'new accounts need a password');
  });

  test('login lists both homes and switching changes the scope', async () => {
    s.ravi = await login('ravi@m.test');
    assert.equal(s.ravi.user.memberships.length, 2);
    const [m1, m2] = s.ravi.user.memberships;
    await api.post('/api/v1/bills/generate').set(bearer(s.one.admin.accessToken)).send({ period: '2026-10' });

    const bills1 = await api.get('/api/v1/bills').set(bearer(s.ravi.accessToken));
    assert.equal(bills1.body.data.length, 1);
    const firstUnit = bills1.body.data[0].unit.label;

    const target = String(s.ravi.user.membershipId) === String(m1._id) ? m2._id : m1._id;
    const sw = await api.post('/api/v1/auth/switch').set(bearer(s.ravi.accessToken)).send({ membershipId: target });
    assert.equal(sw.status, 200, JSON.stringify(sw.body));
    assert.equal(String(sw.body.data.user.membershipId), String(target));
    const bills2 = await api.get('/api/v1/bills').set(bearer(sw.body.data.accessToken));
    assert.equal(bills2.body.data.length, 1);
    assert.notEqual(bills2.body.data[0].unit.label, firstUnit, 'sees only the other flat');

    // refresh keeps the switched context
    const r = await api.post('/api/v1/auth/refresh').send({ refreshToken: sw.body.data.refreshToken });
    assert.equal(String(r.body.data.user.membershipId), String(target));
    s.ravi = r.body.data;
  });

  test('cannot switch to someone else’s membership', async () => {
    const other = await api.post('/api/v1/users').set(bearer(s.one.admin.accessToken)).send({ name: 'Neha', email: 'neha@m.test', password: 'Password@123', role: 'resident', unit: s.one.units[2]._id, residentType: 'tenant' });
    const res = await api.post('/api/v1/auth/switch').set(bearer(s.ravi.accessToken)).send({ membershipId: other.body.data._id });
    assert.equal(res.status, 404);
  });

  test('a resident asks to join a flat in another society; it opens after approval', async () => {
    const ask = await api.post('/api/v1/auth/homes').set(bearer(s.ravi.accessToken)).send({ societyCode: s.two.code, unit: s.two.units[0]._id, residentType: 'tenant' });
    assert.equal(ask.status, 201, JSON.stringify(ask.body));
    const again = await api.post('/api/v1/auth/homes').set(bearer(s.ravi.accessToken)).send({ societyCode: s.two.code, unit: s.two.units[0]._id, residentType: 'tenant' });
    assert.equal(again.status, 409);

    const me = await api.get('/api/v1/auth/me').set(bearer(s.ravi.accessToken));
    const pending = me.body.data.memberships.find((m) => m.status === 'pending');
    assert.equal(pending.society.name, 'Society Two');
    const early = await api.post('/api/v1/auth/switch').set(bearer(s.ravi.accessToken)).send({ membershipId: pending._id });
    assert.equal(early.status, 403);

    const h2 = bearer(s.two.admin.accessToken);
    const list = await api.get('/api/v1/users?status=pending').set(h2);
    assert.equal(list.body.data.length, 1);
    await api.post(`/api/v1/users/${list.body.data[0]._id}/approve`).set(h2);
    const ok = await api.post('/api/v1/auth/switch').set(bearer(s.ravi.accessToken)).send({ membershipId: pending._id });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.user.society.name, 'Society Two');
  });

  test('an admin cannot reset the password or email of someone who also lives in another society', async () => {
    const h2 = bearer(s.two.admin.accessToken);
    const ravi = (await api.get('/api/v1/users?search=ravi').set(h2)).body.data[0];
    const reset = await api.post(`/api/v1/users/${ravi._id}/reset-password`).set(h2).send({ password: 'Hacked@123' });
    assert.equal(reset.status, 403);
    const email = await api.patch(`/api/v1/users/${ravi._id}`).set(h2).send({ email: 'attacker@evil.test' });
    assert.equal(email.status, 403);
    // role / unit changes inside their own society are still allowed
    const role = await api.patch(`/api/v1/users/${ravi._id}`).set(h2).send({ residentType: 'owner' });
    assert.equal(role.status, 200);
  });

  test('public join with an existing email points the person to "Add another home"', async () => {
    const res = await api.post('/api/v1/auth/join').send({ societyCode: s.two.code, name: 'Ravi', email: 'ravi@m.test', password: 'Password@123', unit: s.two.units[1]._id, residentType: 'owner' });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /Add another home/);
  });

  test('deactivating one membership keeps the others working', async () => {
    const h1 = bearer(s.one.admin.accessToken);
    const rows = (await api.get('/api/v1/users?search=ravi').set(h1)).body.data;
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      await api.patch(`/api/v1/users/${r._id}`).set(h1).send({ status: 'inactive' });
    }
    const relog = await login('ravi@m.test');
    assert.equal(relog.user.society.name, 'Society Two', 'lands in the society that is still active');
  });
});

describe('platform console', () => {
  test('only the platform owner can use it; suspending a society locks its members out', async () => {
    const { default: User } = await import('../src/modules/users/user.model.js');
    await User.create({ name: 'Owner', email: 'owner@platform.test', passwordHash: await User.hashPassword('Password@123'), platformRole: 'super_admin' });
    const owner = await login('owner@platform.test');
    assert.equal(owner.user.role, 'super_admin');
    assert.equal(owner.user.society, null);
    const p = bearer(owner.accessToken);

    const forbidden = await api.get('/api/v1/platform/stats').set(bearer(s.two.admin.accessToken));
    assert.equal(forbidden.status, 403, 'society admins are not platform admins');
    const noSociety = await api.get('/api/v1/bills').set(p);
    assert.equal(noSociety.status, 403, 'platform session has no society');

    const stats = await api.get('/api/v1/platform/stats').set(p);
    assert.equal(stats.body.data.societies, 2);
    const list = await api.get('/api/v1/platform/societies?search=Two').set(p);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].units, 3);
    const id = list.body.data[0]._id;

    const susp = await api.patch(`/api/v1/platform/societies/${id}`).set(p).send({ active: false, suspendedReason: 'Unpaid subscription' });
    assert.equal(susp.body.data.active, false);
    const locked = await api.get('/api/v1/dashboard').set(bearer(s.two.admin.accessToken));
    assert.equal(locked.status, 403);
    assert.equal(locked.body.error.code, 'SOCIETY_SUSPENDED');
    await api.patch(`/api/v1/platform/societies/${id}`).set(p).send({ active: true });

    // plan limits
    await api.patch(`/api/v1/platform/societies/${id}`).set(p).send({ plan: { name: 'free', unitLimit: 4 } });
    const h2 = bearer(s.two.admin.accessToken);
    const blocks = (await api.get('/api/v1/blocks').set(h2)).body.data;
    const over = await api.post('/api/v1/units/bulk').set(h2).send({ block: blocks[0]._id, fromFloor: 2, toFloor: 2, unitsPerFloor: 2 });
    assert.equal(over.status, 402);
    assert.equal(over.body.error.code, 'PLAN_LIMIT');
    const one = await api.post('/api/v1/units').set(h2).send({ block: blocks[0]._id, number: '201' });
    assert.equal(one.status, 201, 'one more unit still fits (3 + 1 = 4)');
  });
});
