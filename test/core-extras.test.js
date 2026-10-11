import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Import');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

before(async () => {
  api = await setup();
  const reg = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Core Extras' }, admin: { name: 'Admin', email: 'admin@ce.test', password: 'Password@123' } });
  s.admin = reg.body.data;
  s.societyId = reg.body.data.user.society._id;
});
after(teardown);

describe('forgot password', () => {
  test('reset link works once, signs out other sessions, and unknown emails get the same answer', async () => {
    const unknown = await api.post('/api/v1/auth/password/forgot').send({ email: 'nobody@ce.test' });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.data.devLink, undefined);

    const req = await api.post('/api/v1/auth/password/forgot').send({ email: 'admin@ce.test' });
    const token = new URL(req.body.data.devLink).searchParams.get('token');
    const check = await api.post('/api/v1/auth/password/check').send({ token });
    assert.equal(check.body.data.email, 'admin@ce.test');

    const reset = await api.post('/api/v1/auth/password/reset').send({ token, password: 'NewPassword@123' });
    assert.equal(reset.status, 200);
    const again = await api.post('/api/v1/auth/password/reset').send({ token, password: 'Another@1234' });
    assert.equal(again.status, 400, 'single use');

    const oldRefresh = await api.post('/api/v1/auth/refresh').send({ refreshToken: s.admin.refreshToken });
    assert.equal(oldRefresh.status, 401, 'existing sessions are signed out');
    const login = await api.post('/api/v1/auth/login').send({ identifier: 'admin@ce.test', password: 'NewPassword@123' });
    assert.equal(login.status, 200);
    s.admin = login.body.data;
  });
});

describe('device sessions', () => {
  test('lists sessions, marks the current one, and revokes others', async () => {
    const second = await api.post('/api/v1/auth/login').set('User-Agent', 'Mozilla/5.0 (Linux; Android 14) Chrome/130').send({ identifier: 'admin@ce.test', password: 'NewPassword@123' });
    const h = bearer(s.admin.accessToken);
    const list = await api.post('/api/v1/auth/sessions').set(h).send({ refreshToken: s.admin.refreshToken });
    assert.equal(list.body.data.length, 2);
    assert.equal(list.body.data.filter((x) => x.current).length, 1);
    assert.ok(list.body.data.some((x) => x.device === 'Chrome on Android'));

    await api.post('/api/v1/auth/sessions/revoke-others').set(h).send({ refreshToken: s.admin.refreshToken });
    const dead = await api.post('/api/v1/auth/refresh').send({ refreshToken: second.body.data.refreshToken });
    assert.equal(dead.status, 401);
    const alive = await api.post('/api/v1/auth/refresh').send({ refreshToken: s.admin.refreshToken });
    assert.equal(alive.status, 200);
    s.admin = alive.body.data;
  });
});

describe('spreadsheet import', () => {
  test('units: template, preview with row errors, commit, idempotent re-run', async () => {
    const h = bearer(s.admin.accessToken);
    const tpl = await api.get('/api/v1/imports/units/template').set(h);
    assert.equal(tpl.status, 200);
    assert.match(tpl.headers['content-type'], /spreadsheetml/);

    const file = await xlsx([['Block', 'Unit number', 'Floor', 'Type', 'Area sqft'], ['A', '101', 1, 'flat', 1000], ['A', '102', 1, 'flat', 1000], ['B', '201', 2, 'castle', 900], ['A', '101', 1, 'flat', 1000]]);
    const prev = await api.post('/api/v1/imports/units/preview').set(h).attach('file', file, 'units.xlsx');
    assert.equal(prev.status, 200, JSON.stringify(prev.body));
    assert.equal(prev.body.data.valid, 2);
    assert.equal(prev.body.data.invalid, 2);

    const commit = await api.post('/api/v1/imports/units/commit').set(h).attach('file', file, 'units.xlsx');
    assert.equal(commit.body.data.created, 2);
    const again = await api.post('/api/v1/imports/units/commit').set(h).attach('file', file, 'units.xlsx');
    assert.equal(again.body.data.created, 0);
    assert.equal(again.body.data.skipped, 2);
  });

  test('members from CSV: residents need an existing unit; new accounts get an invite', async () => {
    const h = bearer(s.admin.accessToken);
    const csv = Buffer.from('Name,Email,Phone,Role,Unit,Resident type,Designation\nRavi Iyer,ravi@ce.test,9811111111,resident,A-101,owner,\nNo Unit,nounit@ce.test,,resident,Z-999,,\nRamesh,,9822222222,guard,,,Main gate\n');
    const prev = await api.post('/api/v1/imports/members/preview').set(h).attach('file', csv, 'members.csv');
    assert.equal(prev.body.data.valid, 2, JSON.stringify(prev.body.data.rows));
    const commit = await api.post('/api/v1/imports/members/commit').set(h).attach('file', csv, 'members.csv');
    assert.equal(commit.body.data.created, 2);
    assert.equal(commit.body.data.invalid, 1);
    const members = await api.get('/api/v1/users?search=ravi').set(h);
    assert.equal(members.body.data[0].unit.label, 'A-101');
  });

  test('residents cannot import', async () => {
    const r = await api.post('/api/v1/auth/login').send({ identifier: '9811111111', password: 'x' });
    assert.equal(r.status, 401, 'imported accounts have a random password until they accept the invite');
  });
});

describe('platform support session', () => {
  test('time-limited admin access is audited, hidden from members, and blocked for non-owners', async () => {
    const { default: User } = await import('../src/modules/users/user.model.js');
    await User.create({ name: 'Owner', email: 'owner@ce.test', passwordHash: await User.hashPassword('Password@123'), platformRole: 'super_admin' });
    const owner = (await api.post('/api/v1/auth/login').send({ identifier: 'owner@ce.test', password: 'Password@123' })).body.data;

    const denied = await api.post('/api/v1/auth/support-session').set(bearer(s.admin.accessToken)).send({ societyId: s.societyId });
    assert.equal(denied.status, 403);

    const sess = await api.post('/api/v1/auth/support-session').set(bearer(owner.accessToken)).send({ societyId: s.societyId, reason: 'Ticket #12' });
    assert.equal(sess.status, 200, JSON.stringify(sess.body));
    assert.equal(sess.body.data.user.role, 'admin');
    const units = await api.get('/api/v1/units').set(bearer(sess.body.data.accessToken));
    assert.equal(units.status, 200);

    const members = await api.get('/api/v1/users').set(bearer(s.admin.accessToken));
    assert.ok(!members.body.data.some((m) => m.email === 'owner@ce.test'), 'support membership hidden from member list');
    const logs = await api.get('/api/v1/audit-logs').set(bearer(s.admin.accessToken));
    assert.ok(logs.body.data.some((l) => l.action === 'platform.support_session_started'));

    const { default: Membership } = await import('../src/modules/users/membership.model.js');
    await Membership.updateOne({ support: true }, { expiresAt: new Date(Date.now() - 1000) });
    const expired = await api.get('/api/v1/units').set(bearer(sess.body.data.accessToken));
    assert.equal(expired.status, 401, 'access ends when the session expires');
  });
});

describe('trial plan', () => {
  test('new societies get every module for 30 days, then fall back to free', async () => {
    const reg = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Trial Towers' }, admin: { name: 'Trial Admin', email: 'trial@ce.test', password: 'Password@123' } });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const h = bearer(reg.body.data.accessToken);
    const f = await api.get('/api/v1/features').set(h);
    assert.equal(f.body.data.plan, 'trial');
    assert.ok(f.body.data.enabled.includes('parking') && f.body.data.enabled.includes('accounting'));
    assert.equal((await api.get('/api/v1/parking/summary').set(h)).status, 200);

    const { default: Society } = await import('../src/modules/society/society.model.js');
    const { clearCache } = await import('../src/modules/features/features.service.js');
    await Society.updateOne({ name: 'Trial Towers' }, { 'plan.validUntil': new Date(Date.now() - 1000) });
    clearCache();
    const after = await api.get('/api/v1/features').set(h);
    assert.equal(after.body.data.plan, 'free');
    assert.equal((await api.get('/api/v1/parking/summary').set(h)).status, 402, 'gated after the trial');
  });
});
