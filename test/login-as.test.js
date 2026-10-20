import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

const V = '/api/v1';
const PASSWORD = 'Password@123';
let api;
let models;
let totp;
let service;
const s = {};

const ok = (res, status = 200) => assert.equal(res.status, status, `${res.req?.method} ${res.req?.path}: ${JSON.stringify(res.body)}`);
const login = async (identifier, password = PASSWORD) => {
  const res = await api.post(`${V}/auth/login`).send({ identifier, password });
  ok(res);
  return res.body.data;
};
const startAs = (h, membershipId, extra = {}) => api.post(`${V}/login-as`).set(h).send({ membershipId, password: PASSWORD, reason: 'Checking a reported issue', ...extra });

async function newSociety(name, email) {
  const reg = await api.post(`${V}/auth/register-society`).send({ society: { name }, admin: { name: `${name} Admin`, email, password: PASSWORD } });
  ok(reg, 201);
  const h = bearer(reg.body.data.accessToken);
  const block = await api.post(`${V}/blocks`).set(h).send({ name: 'A' });
  await api.post(`${V}/units/bulk`).set(h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 4, areaSqft: 1000 });
  const units = (await api.get(`${V}/units`).set(h)).body.data;
  return { session: reg.body.data, h, id: reg.body.data.user.society._id, units, adminMid: reg.body.data.user.membershipId };
}

async function addMember(soc, body) {
  const res = await api.post(`${V}/users`).set(soc.h).send({ password: PASSWORD, ...body });
  ok(res, 201);
  return res.body.data; // membership (with .user)
}

before(async () => {
  api = await setup();
  models = {
    User: (await import('../src/modules/users/user.model.js')).default,
    Membership: (await import('../src/modules/users/membership.model.js')).default,
    AuditLog: (await import('../src/modules/audit/audit.model.js')).default,
    PlatformAudit: (await import('../src/modules/platformTeam/platformAudit.model.js')).default,
    LoginAsSession: (await import('../src/modules/loginAs/loginAsSession.model.js')).default,
  };
  totp = await import('../src/common/utils/totp.js');
  service = await import('../src/modules/loginAs/loginAs.service.js');
  const access = await import('../src/modules/platformTeam/access.js');

  s.A = await newSociety('Asha Towers', 'admin@a.test');
  s.B = await newSociety('Banyan Court', 'admin@b.test');
  const u = s.A.units;
  s.ravi = await addMember(s.A, { name: 'Ravi Iyer', email: 'ravi@a.test', role: 'resident', unit: u[0]._id, residentType: 'owner' });
  s.guard = await addMember(s.A, { name: 'Gopal Guard', email: 'guard@a.test', role: 'guard' });
  s.staff = await addMember(s.A, { name: 'Sunil Staff', email: 'staff@a.test', role: 'staff' });
  s.acc = await addMember(s.A, { name: 'Anu Accounts', email: 'acc@a.test', role: 'accountant' });
  s.fm = await addMember(s.A, { name: 'Farhan FM', email: 'fm@a.test', role: 'facility_manager' });
  s.admin2 = await addMember(s.A, { name: 'Second Admin', email: 'admin2@a.test', role: 'admin' });
  s.pooja = await addMember(s.A, { name: 'Pooja Former', email: 'pooja@a.test', role: 'resident', unit: u[1]._id, residentType: 'tenant' });
  s.bRes = await addMember(s.B, { name: 'Bina Resident', email: 'bina@b.test', role: 'resident', unit: s.B.units[0]._id, residentType: 'owner' });

  // Platform owner, who is also a resident in society A (a platform user as a target).
  const owner = await models.User.create({ name: 'Platform Owner', email: 'owner@p.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'super_admin' });
  s.ownerAsResident = await models.Membership.create({ user: owner._id, society: s.A.id, role: 'resident', unit: u[2]._id, residentType: 'owner', status: 'active' });
  // A platform member whose role has neither support.access nor impersonation.manage.
  const billing = await access.systemRole('billing');
  await models.User.create({ name: 'Billing Person', email: 'billing@p.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'staff', platformRoleId: billing._id });

  s.owner = await login('owner@p.test');
  // Owner lands in their resident home; switch to the platform console.
  const sw = await api.post(`${V}/auth/switch`).set(bearer(s.owner.accessToken)).send({ membershipId: null });
  ok(sw);
  s.p = bearer(sw.body.data.accessToken);
  s.billingH = bearer((await login('billing@p.test')).accessToken);
  s.accH = bearer((await login('acc@a.test')).accessToken);
  s.fmH = bearer((await login('fm@a.test')).accessToken);
  s.raviSession = await login('ravi@a.test');
});
after(teardown);

describe('starting a session', () => {
  test('admin logs in as a resident with their own password; the session acts as the resident', async () => {
    const res = await startAs(s.A.h, s.ravi._id, { minutes: 30 });
    ok(res, 201);
    const d = res.body.data;
    assert.equal(d.user.role, 'resident');
    assert.equal(d.user.name, 'Ravi Iyer');
    assert.equal(d.actingAs.byName, 'Asha Towers Admin');
    assert.equal(d.actingAs.byLevel, 'admin');
    assert.equal(d.actingAs.reason, 'Checking a reported issue');
    const mins = (new Date(d.expiresAt) - Date.now()) / 60000;
    assert.ok(mins > 29 && mins <= 30, `expires in ~30 min (${mins})`);
    s.acting = bearer(d.accessToken);
    s.actingToken = d.accessToken;

    const me = await api.get(`${V}/auth/me`).set(s.acting);
    ok(me);
    assert.equal(me.body.data.role, 'resident');
    assert.equal(String(me.body.data.actingAs.by), String(s.A.session.user._id));
    assert.equal(me.body.data.memberships.length, 1, 'only the viewed membership is listed');
    assert.equal(me.body.data.platformPermissions, null);
    const cur = await api.get(`${V}/login-as/current`).set(s.acting);
    ok(cur);
    assert.equal(cur.body.data.byName, 'Asha Towers Admin');

    // Resident-only views work, admin views do not.
    ok(await api.get(`${V}/bills`).set(s.acting));
    assert.equal((await api.get(`${V}/users`).set(s.acting)).status, 403);
    const row = await models.LoginAsSession.findById(d.actingAs.sessionId).lean();
    assert.ok(row.requests >= 3, 'every request is counted against the session');
  });

  test('wrong password, missing reason and too long a session are refused', async () => {
    const wrong = await startAs(s.A.h, s.guard._id, { password: 'nope-nope' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'PASSWORD_INCORRECT');
    assert.equal((await startAs(s.A.h, s.guard._id, { reason: '' })).status, 422);
    assert.equal((await startAs(s.A.h, s.guard._id, { minutes: 121 })).status, 422);
  });

  test('cannot target equal or higher levels, platform users, deactivated people or other societies', async () => {
    assert.equal((await startAs(s.A.h, s.admin2._id)).status, 403, 'admin -> admin');
    assert.equal((await startAs(s.A.h, s.A.adminMid)).status, 400, 'yourself');
    const platformTarget = await startAs(s.A.h, s.ownerAsResident._id);
    assert.equal(platformTarget.status, 403);
    assert.match(platformTarget.body.error.message, /platform team/);
    assert.equal((await startAs(s.A.h, s.bRes._id)).status, 404, 'other society');

    ok(await api.patch(`${V}/users/${s.pooja._id}`).set(s.A.h).send({ status: 'inactive' }));
    assert.equal((await startAs(s.A.h, s.pooja._id)).status, 403, 'deactivated');

    assert.equal((await api.post(`${V}/login-as`).set(bearer(s.raviSession.accessToken)).send({ membershipId: s.guard._id, password: PASSWORD, reason: 'test test' })).status, 403, 'residents cannot');
  });

  test('no nesting and no account changes from inside a session', async () => {
    const nested = await startAs(s.acting, s.guard._id);
    assert.equal(nested.status, 409);
    assert.equal(nested.body.error.code, 'ALREADY_ACTING');
    const sw = await api.post(`${V}/auth/switch`).set(s.acting).send({ membershipId: s.ravi._id });
    assert.equal(sw.status, 403);
    assert.equal(sw.body.error.code, 'NOT_WHILE_ACTING');
    assert.equal((await api.post(`${V}/auth/change-password`).set(s.acting).send({ currentPassword: PASSWORD, newPassword: 'Another@123' })).status, 403);
    assert.equal((await api.post(`${V}/auth/mfa/setup`).set(s.acting)).status, 403);
    assert.equal((await api.patch(`${V}/auth/me`).set(s.acting).send({ name: 'Hacked' })).status, 403);
  });

  test('exit ends the session; the original session keeps working', async () => {
    const exit = await api.post(`${V}/login-as/exit`).set(s.acting);
    ok(exit);
    assert.equal(exit.body.data.endedReason, 'exit');
    const after = await api.get(`${V}/auth/me`).set(s.acting);
    assert.equal(after.status, 401);
    assert.equal(after.body.error.code, 'ACTING_ENDED');
    const me = await api.get(`${V}/auth/me`).set(s.A.h);
    ok(me);
    assert.equal(me.body.data.role, 'admin');
    assert.equal(me.body.data.actingAs, undefined);
    const refreshed = await api.post(`${V}/auth/refresh`).send({ refreshToken: s.A.session.refreshToken });
    ok(refreshed);
    assert.equal(refreshed.body.data.user.role, 'admin');
    s.A.session = refreshed.body.data;
    s.A.h = bearer(refreshed.body.data.accessToken);
    // A second exit is harmless.
    ok(await api.post(`${V}/login-as/exit`).set(s.acting));
  });

  test('start and exit are audited with who, whom, reason and duration; the resident sees it', async () => {
    const logs = (await api.get(`${V}/audit-logs`).set(s.A.h).query({ limit: 100 })).body.data;
    const started = logs.find((l) => l.action === 'login_as.started');
    const ended = logs.find((l) => l.action === 'login_as.ended');
    assert.ok(started && ended);
    assert.equal(started.meta.targetName, 'Ravi Iyer');
    assert.equal(started.meta.reason, 'Checking a reported issue');
    assert.equal(started.meta.byName, 'Asha Towers Admin');
    assert.equal(ended.meta.endedReason, 'exit');
    assert.equal(typeof ended.meta.durationSeconds, 'number');

    const activity = await api.get(`${V}/login-as/me/activity`).set(bearer(s.raviSession.accessToken));
    ok(activity);
    assert.equal(activity.body.data.length, 1);
    assert.equal(activity.body.data[0].byName, 'Asha Towers Admin');
    assert.equal(activity.body.data[0].status, 'exit');

    const sessions = await api.get(`${V}/login-as/sessions`).set(s.A.h);
    ok(sessions);
    assert.equal(sessions.body.data.length, 1);
    assert.equal((await api.get(`${V}/login-as/sessions`).set(s.accH)).status, 403, 'society log is for admins');
  });

  test('actions taken while acting are attributed in the audit log', async () => {
    const audit = await import('../src/modules/audit/audit.service.js');
    audit.record({ societyId: s.A.id, userId: s.ravi.user, user: { actingAs: { by: s.A.session.user._id, byName: 'Asha Towers Admin', sessionId: s.A.id } } }, 'test.action', 'Test', s.A.id, { x: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const row = await models.AuditLog.findOne({ action: 'test.action' }).lean();
    assert.equal(row.meta.x, 1);
    assert.equal(row.meta.actingAs.byName, 'Asha Towers Admin');
  });

  test('sessions expire on time and are closed and logged by the job', async () => {
    const res = await startAs(s.A.h, s.staff._id, { minutes: 5 });
    ok(res, 201);
    const h = bearer(res.body.data.accessToken);
    ok(await api.get(`${V}/auth/me`).set(h));
    await models.LoginAsSession.updateOne({ _id: res.body.data.actingAs.sessionId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await api.get(`${V}/auth/me`).set(h)).status, 401);
    const { closed } = await service.closeExpired();
    assert.equal(closed, 1);
    const row = await models.LoginAsSession.findById(res.body.data.actingAs.sessionId).lean();
    assert.equal(row.endedReason, 'expired');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await models.AuditLog.exists({ action: 'login_as.ended', 'meta.endedReason': 'expired' }));
  });

  test('starting a new session closes one left open', async () => {
    const first = await startAs(s.A.h, s.guard._id);
    ok(first, 201);
    const second = await startAs(s.A.h, s.staff._id);
    ok(second, 201);
    assert.equal((await api.get(`${V}/auth/me`).set(bearer(first.body.data.accessToken))).status, 401);
    ok(await api.post(`${V}/login-as/exit`).set(bearer(second.body.data.accessToken)));
  });
});

describe('two-step confirmation', () => {
  test('an actor with two-step verification on must also give a current code', async () => {
    const setupRes = await api.post(`${V}/auth/mfa/setup`).set(s.B.h);
    ok(setupRes);
    const secret = setupRes.body.data.secret;
    ok(await api.post(`${V}/auth/mfa/enable`).set(s.B.h).send({ code: totp.totp(secret) }));

    const noCode = await startAs(s.B.h, s.bRes._id);
    assert.equal(noCode.status, 400);
    assert.equal(noCode.body.error.code, 'MFA_CODE_REQUIRED');
    const badCode = await startAs(s.B.h, s.bRes._id, { code: '000000' });
    assert.equal(badCode.status, 400);
    // The enabling code burnt the current step; the next step's code is accepted (±1 step window).
    const good = await startAs(s.B.h, s.bRes._id, { code: totp.totp(secret, Date.now() + 30000) });
    ok(good, 201);
    ok(await api.post(`${V}/login-as/exit`).set(bearer(good.body.data.accessToken)));
  });
});

describe('who may use it (platform policy)', () => {
  test('society admins see their rules read-only; sub-admins are off by default', async () => {
    const admin = await api.get(`${V}/login-as/rules`).set(s.A.h);
    ok(admin);
    assert.equal(admin.body.data.allowed, true);
    assert.deepEqual([...admin.body.data.canTarget].sort(), ['accountant', 'facility_manager', 'guard', 'resident', 'staff']);
    const acc = await api.get(`${V}/login-as/rules`).set(s.accH);
    ok(acc);
    assert.equal(acc.body.data.allowed, false);
    const denied = await startAs(s.accH, s.guard._id);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'LOGIN_AS_DISABLED');
    assert.equal((await api.put(`${V}/login-as/platform/policy`).set(s.A.h).send({ subadmin: true })).status, 403, 'society admins cannot change it');
  });

  test('platform turns sub-admins on; they reach guards/residents/staff but not each other', async () => {
    const put = await api.put(`${V}/login-as/platform/policy`).set(s.p).send({ subadmin: true });
    ok(put);
    assert.equal(put.body.data.policy.subadmin, true);
    const res = await startAs(s.accH, s.guard._id);
    ok(res, 201);
    ok(await api.post(`${V}/login-as/exit`).set(bearer(res.body.data.accessToken)));
    assert.equal((await startAs(s.fmH, s.acc._id)).status, 403, 'FM -> accountant is the same level');
    assert.equal((await startAs(s.accH, s.A.adminMid)).status, 403, 'accountant -> admin is higher');
    ok(await api.put(`${V}/login-as/platform/policy`).set(s.p).send({ subadmin: false }));
    assert.equal((await startAs(s.accH, s.guard._id)).status, 403);
  });

  test('per-society override beats the platform rule, and null restores it', async () => {
    const put = await api.put(`${V}/login-as/platform/societies/${s.A.id}/policy`).set(s.p).send({ admin: false });
    ok(put);
    assert.equal(put.body.data.effective.admin, false);
    assert.equal((await startAs(s.A.h, s.ravi._id)).status, 403, 'off for society A');
    // Society B keeps the platform rule. Its admin has two-step on, so being asked for the code proves the
    // policy check passed there.
    const other = await startAs(s.B.h, s.bRes._id);
    assert.equal(other.body.error.code, 'MFA_CODE_REQUIRED');
    const rules = await api.get(`${V}/login-as/rules`).set(s.A.h);
    assert.equal(rules.body.data.allowed, false);
    ok(await api.put(`${V}/login-as/platform/societies/${s.A.id}/policy`).set(s.p).send({ admin: null }));
    const back = await startAs(s.A.h, s.ravi._id);
    ok(back, 201);
    ok(await api.post(`${V}/login-as/exit`).set(bearer(back.body.data.accessToken)));
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await models.AuditLog.exists({ society: s.A.id, action: 'login_as.policy_changed' }), 'society sees the change in its log');
  });
});

describe('platform team', () => {
  test('platform owner can log in as anyone in any society, audited on the platform too', async () => {
    const res = await startAs(s.p, s.A.adminMid, { reason: 'Ticket #42' });
    ok(res, 201);
    assert.equal(res.body.data.user.role, 'admin');
    assert.equal(res.body.data.actingAs.byLevel, 'platform');
    const h = bearer(res.body.data.accessToken);
    ok(await api.get(`${V}/users`).set(h));
    assert.equal((await api.get(`${V}/platform/stats`).set(h)).status, 403, 'no platform console from inside');
    ok(await api.post(`${V}/login-as/exit`).set(h));
    await new Promise((r) => setTimeout(r, 100));
    const rows = await models.PlatformAudit.find({ action: { $in: ['login_as.started', 'login_as.ended'] } }).lean();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].details.reason, 'Ticket #42');
  });

  test('platform members without support / impersonation permission are refused', async () => {
    assert.equal((await startAs(s.billingH, s.ravi._id)).status, 403);
    assert.equal((await api.get(`${V}/login-as/platform/policy`).set(s.billingH)).status, 403);
  });

  test('switching the platform level off blocks the platform', async () => {
    ok(await api.put(`${V}/login-as/platform/policy`).set(s.p).send({ platform: false }));
    const res = await startAs(s.p, s.ravi._id);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'LOGIN_AS_DISABLED');
    ok(await api.put(`${V}/login-as/platform/policy`).set(s.p).send({ platform: true }));
  });

  test('society member list for the console says who can be viewed', async () => {
    const res = await api.get(`${V}/login-as/platform/societies/${s.A.id}/members`).set(s.p).query({ limit: 50 });
    ok(res);
    const byName = Object.fromEntries(res.body.data.map((m) => [m.name, m]));
    assert.equal(byName['Ravi Iyer'].canLoginAs, true);
    assert.equal(byName['Platform Owner'].canLoginAs, false);
    assert.equal(byName['Pooja Former'], undefined, 'inactive memberships are not listed');
    const sessions = await api.get(`${V}/login-as/platform/sessions`).set(s.p);
    ok(sessions);
    assert.ok(sessions.body.meta.total >= 5);
  });
});
