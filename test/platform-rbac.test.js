import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
let models;
let team;
const s = {};
const PASSWORD = 'Password@123';
const NEW_PASSWORD = 'NewPassw0rd!';

const login = async (identifier, password = PASSWORD) => api.post('/api/v1/auth/login').send({ identifier, password });
const ok = (res, status = 200) => assert.equal(res.status, status, `${res.req?.method} ${res.req?.path}: ${JSON.stringify(res.body)}`);
const roleId = (key) => s.roles.find((r) => r.key === key)._id;

// Invites a member through the API, sets their password from the returned link and logs them in.
async function inviteAndLogin(email, roleIdValue, by = s.p) {
  const inv = await api.post('/api/v1/platform/team').set(by).send({ name: email.split('@')[0], email, roleId: roleIdValue });
  ok(inv, 201);
  assert.ok(inv.body.data.inviteLink, 'console email returns the set-password link');
  const token = new URL(inv.body.data.inviteLink).searchParams.get('token');
  ok(await api.post('/api/v1/auth/password/reset').send({ token, password: NEW_PASSWORD }));
  const res = await login(email, NEW_PASSWORD);
  ok(res);
  return { id: inv.body.data.member._id, session: res.body.data, h: bearer(res.body.data.accessToken) };
}

before(async () => {
  api = await setup();
  models = {
    User: (await import('../src/modules/users/user.model.js')).default,
    PlatformAudit: (await import('../src/modules/platformTeam/platformAudit.model.js')).default,
  };
  team = await import('../src/modules/platformTeam/platformTeam.service.js');

  const reg = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Rbac Towers' }, admin: { name: 'Rbac Admin', email: 'admin@rbac.test', password: PASSWORD } });
  ok(reg, 201);
  s.admin = bearer(reg.body.data.accessToken);
  s.societyId = reg.body.data.user.society._id;

  await models.User.create({ name: 'Owner', email: 'owner@rbac.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'super_admin' });
  const owner = await login('owner@rbac.test');
  ok(owner);
  s.owner = owner.body.data;
  s.p = bearer(s.owner.accessToken);

  const roles = await api.get('/api/v1/platform/roles').set(s.p);
  ok(roles);
  s.roles = roles.body.data;

  s.billing = await inviteAndLogin('billing@rbac.test', roleId('billing'));
  s.support = await inviteAndLogin('support@rbac.test', roleId('support'));
  s.viewer = await inviteAndLogin('viewer@rbac.test', roleId('viewer'));

  const ticket = await api.post('/api/v1/support/tickets').set(s.admin).send({ category: 'technical', subject: 'Gate app is slow', description: 'Since Monday' });
  ok(ticket, 201);
  s.ticketId = ticket.body.data._id;
});
after(teardown);

describe('roles and permissions', () => {
  test('built-in roles exist and are read-only', async () => {
    assert.deepEqual(s.roles.filter((r) => r.system).map((r) => r.name), ['Owner', 'Admin', 'Billing', 'Support', 'Onboarding / Sales', 'Viewer']);
    const cat = await api.get('/api/v1/platform/permissions').set(s.viewer.h);
    ok(cat);
    const all = cat.body.data.groups.flatMap((g) => g.permissions.map((p) => p.key));
    assert.ok(all.includes('luckydraw.oversee') && all.includes('team.manage'));
    assert.deepEqual([...s.roles.find((r) => r.key === 'owner').permissions].sort(), [...all].sort());
    assert.ok(!s.roles.find((r) => r.key === 'admin').permissions.includes('team.manage'));
    assert.ok(s.roles.find((r) => r.key === 'viewer').permissions.every((p) => p.endsWith('.view')));
    const fresh = (await api.get('/api/v1/platform/roles').set(s.p)).body.data;
    assert.equal(fresh.find((r) => r.key === 'owner').memberCount, 1);
    assert.equal(fresh.find((r) => r.key === 'billing').memberCount, 1);

    const edit = await api.patch(`/api/v1/platform/roles/${roleId('admin')}`).set(s.p).send({ permissions: ['societies.view'] });
    assert.equal(edit.status, 403);
    const del = await api.delete(`/api/v1/platform/roles/${roleId('viewer')}`).set(s.p);
    assert.equal(del.status, 403);
  });

  test('sessions and /auth/me carry the permissions', async () => {
    assert.equal(s.owner.user.platformRoleName, 'Owner');
    assert.ok(s.owner.user.platformPermissions.includes('team.manage'));
    const me = await api.get('/api/v1/auth/me').set(s.billing.h);
    ok(me);
    assert.equal(me.body.data.platformRoleName, 'Billing');
    assert.ok(me.body.data.platformPermissions.includes('billing.run'));
    assert.ok(!me.body.data.platformPermissions.includes('societies.suspend'));
    assert.equal(me.body.data.role, 'super_admin', 'platform members keep the console role key');
    // A society member is not on the platform team.
    const adminMe = await api.get('/api/v1/auth/me').set(s.admin);
    assert.equal(adminMe.body.data.platformPermissions, null);
    assert.equal((await api.get('/api/v1/platform/stats').set(s.admin)).status, 403);
  });

  test('owner can do everything', async () => {
    ok(await api.get('/api/v1/platform/stats').set(s.p));
    ok(await api.get('/api/v1/platform/jobs').set(s.p));
    ok(await api.patch(`/api/v1/platform/societies/${s.societyId}`).set(s.p).send({ platformNotes: 'Key account' }));
    ok(await api.put(`/api/v1/platform/societies/${s.societyId}/features`).set(s.p).send({ overrides: { parking: false } }));
    ok(await api.put('/api/v1/platform/plans/basic').set(s.p).send({ perUnitMonthly: 1500, flatMonthly: 0 }));
    ok(await api.post('/api/v1/platform/billing/run').set(s.p));
    ok(await api.patch(`/api/v1/platform/societies/${s.societyId}`).set(s.p).send({ active: false, suspendedReason: 'Testing' }));
    ok(await api.patch(`/api/v1/platform/societies/${s.societyId}`).set(s.p).send({ active: true }));
    ok(await api.get('/api/v1/platform/activity').set(s.p));
  });

  test('Billing runs billing and edits prices, but cannot suspend, edit societies or manage the team', async () => {
    ok(await api.post('/api/v1/platform/billing/run').set(s.billing.h));
    ok(await api.put('/api/v1/platform/plans/standard').set(s.billing.h).send({ perUnitMonthly: 1200, flatMonthly: 0 }));
    ok(await api.get('/api/v1/platform/invoices').set(s.billing.h));
    ok(await api.get('/api/v1/platform/societies').set(s.billing.h));
    assert.equal((await api.patch(`/api/v1/platform/societies/${s.societyId}`).set(s.billing.h).send({ active: false })).status, 403);
    assert.equal((await api.patch(`/api/v1/platform/societies/${s.societyId}`).set(s.billing.h).send({ platformNotes: 'x' })).status, 403);
    assert.equal((await api.put(`/api/v1/platform/societies/${s.societyId}/features`).set(s.billing.h).send({ overrides: { parking: true } })).status, 403);
    assert.equal((await api.get('/api/v1/platform/team').set(s.billing.h)).status, 403);
    assert.equal((await api.get('/api/v1/platform/roles').set(s.billing.h)).status, 403);
    assert.equal((await api.get('/api/v1/platform/activity').set(s.billing.h)).status, 403);
    assert.equal((await api.get('/api/v1/platform/support/tickets').set(s.billing.h)).status, 403);
    assert.equal((await api.post('/api/v1/auth/support-session').set(s.billing.h).send({ societyId: s.societyId })).status, 403);
  });

  test('Support replies to tickets and opens support sessions, but cannot edit plans or societies', async () => {
    ok(await api.post(`/api/v1/platform/support/tickets/${s.ticketId}/messages`).set(s.support.h).send({ text: 'Looking into it', status: 'in_progress' }));
    ok(await api.post(`/api/v1/platform/support/tickets/${s.ticketId}/assign`).set(s.support.h).send({}));
    const session = await api.post('/api/v1/auth/support-session').set(s.support.h).send({ societyId: s.societyId, reason: 'Ticket check' });
    ok(session);
    assert.equal(session.body.data.user.role, 'admin');
    assert.equal((await api.put('/api/v1/platform/plans/basic').set(s.support.h).send({ perUnitMonthly: 1 })).status, 403);
    assert.equal((await api.patch(`/api/v1/platform/societies/${s.societyId}`).set(s.support.h).send({ active: false })).status, 403);
    assert.equal((await api.post('/api/v1/platform/billing/run').set(s.support.h)).status, 403);
    assert.equal((await api.post('/api/v1/platform/invoices/000000000000000000000000/void').set(s.support.h).send({ reason: 'x' })).status, 403);
  });

  test('ticket assignees are members who can reply', async () => {
    const t = await api.get('/api/v1/platform/support/team').set(s.support.h);
    ok(t);
    const emails = t.body.data.map((u) => u.email).sort();
    assert.deepEqual(emails, ['owner@rbac.test', 'support@rbac.test']);
    const bad = await api.post(`/api/v1/platform/support/tickets/${s.ticketId}/assign`).set(s.p).send({ assignedTo: s.billing.id });
    assert.equal(bad.status, 400);
    ok(await api.post(`/api/v1/platform/support/tickets/${s.ticketId}/assign`).set(s.p).send({ assignedTo: s.support.id }));
  });

  test('Viewer is read-only: every write is 403', async () => {
    for (const path of ['/stats', '/jobs', '/societies', `/societies/${s.societyId}`, '/plans', '/invoices', '/invoices/summary', '/support/tickets', '/activity', `/subscriptions/${s.societyId}`]) {
      ok(await api.get(`/api/v1/platform${path}`).set(s.viewer.h));
    }
    const writes = [
      ['patch', `/platform/societies/${s.societyId}`, { platformNotes: 'x' }],
      ['patch', `/platform/societies/${s.societyId}`, { active: false }],
      ['put', `/platform/societies/${s.societyId}/features`, { overrides: { parking: true } }],
      ['put', '/platform/plans/basic', { perUnitMonthly: 1 }],
      ['post', '/platform/billing/run', {}],
      ['post', '/platform/invoices/000000000000000000000000/mark-paid', { method: 'bank' }],
      ['patch', `/platform/subscriptions/${s.societyId}`, { graceDays: 3 }],
      ['post', `/platform/support/tickets/${s.ticketId}/messages`, { text: 'hi' }],
      ['post', `/platform/support/tickets/${s.ticketId}/status`, { status: 'resolved' }],
      ['post', `/platform/support/tickets/${s.ticketId}/assign`, {}],
      ['post', '/platform/team', { name: 'X Y', email: 'x@rbac.test', roleId: roleId('viewer') }],
      ['post', '/platform/roles', { name: 'Mine', permissions: ['societies.view'] }],
      ['post', '/auth/support-session', { societyId: s.societyId }],
      ['post', '/privacy/deletion-requests/000000000000000000000000/approve', {}],
    ];
    for (const [method, path, body] of writes) {
      const res = await api[method](`/api/v1${path}`).set(s.viewer.h).send(body);
      assert.equal(res.status, 403, `${method} ${path} → ${res.status}`);
    }
  });
});

describe('custom roles and team management', () => {
  test('a custom role grants exactly what it lists', async () => {
    const role = await api.post('/api/v1/platform/roles').set(s.p).send({ name: 'Ticket triage', description: 'Reads and routes tickets', permissions: ['support.view', 'support.assign', 'societies.view'] });
    ok(role, 201);
    s.triageRole = role.body.data._id;
    const dup = await api.post('/api/v1/platform/roles').set(s.p).send({ name: 'ticket TRIAGE', permissions: ['support.view'] });
    assert.equal(dup.status, 409);
    s.triage = await inviteAndLogin('triage@rbac.test', s.triageRole);
    ok(await api.get('/api/v1/platform/support/tickets').set(s.triage.h));
    ok(await api.post(`/api/v1/platform/support/tickets/${s.ticketId}/assign`).set(s.triage.h).send({ assignedTo: s.support.id }));
    assert.equal((await api.post(`/api/v1/platform/support/tickets/${s.ticketId}/messages`).set(s.triage.h).send({ text: 'hi' })).status, 403);
    assert.equal((await api.get('/api/v1/platform/invoices').set(s.triage.h)).status, 403);

    // Editing the role changes access on the very next request.
    ok(await api.patch(`/api/v1/platform/roles/${s.triageRole}`).set(s.p).send({ permissions: ['support.view', 'support.assign', 'societies.view', 'invoices.view'] }));
    ok(await api.get('/api/v1/platform/invoices').set(s.triage.h));

    const del = await api.delete(`/api/v1/platform/roles/${s.triageRole}`).set(s.p);
    assert.equal(del.status, 409, 'cannot delete a role that is assigned');
  });

  test('a non-owner team manager cannot touch owners or grant what they lack', async () => {
    const role = await api.post('/api/v1/platform/roles').set(s.p).send({ name: 'People ops', permissions: ['team.manage', 'societies.view'] });
    ok(role, 201);
    s.peopleOps = await inviteAndLogin('people@rbac.test', role.body.data._id);
    ok(await api.get('/api/v1/platform/team').set(s.peopleOps.h));
    assert.equal((await api.patch(`/api/v1/platform/team/${s.owner.user._id}`).set(s.peopleOps.h).send({ roleId: roleId('viewer') })).status, 403);
    assert.equal((await api.post(`/api/v1/platform/team/${s.owner.user._id}/deactivate`).set(s.peopleOps.h)).status, 403);
    assert.equal((await api.patch(`/api/v1/platform/team/${s.viewer.id}`).set(s.peopleOps.h).send({ roleId: roleId('owner') })).status, 403);
    assert.equal((await api.patch(`/api/v1/platform/team/${s.viewer.id}`).set(s.peopleOps.h).send({ roleId: roleId('billing') })).status, 403, 'billing perms it does not hold');
    assert.equal((await api.post('/api/v1/platform/roles').set(s.peopleOps.h).send({ name: 'Sneaky', permissions: ['billing.run'] })).status, 403);
  });

  test('nobody can change their own role, and the last active owner stays', async () => {
    const self = await api.patch(`/api/v1/platform/team/${s.owner.user._id}`).set(s.p).send({ roleId: roleId('viewer') });
    assert.equal(self.status, 400);
    assert.equal((await api.post(`/api/v1/platform/team/${s.owner.user._id}/deactivate`).set(s.p)).status, 400);
    assert.equal((await api.delete(`/api/v1/platform/team/${s.owner.user._id}`).set(s.p)).status, 400);

    // A second owner can demote the first while two exist; the guard stops the last one going.
    const second = await inviteAndLogin('owner2@rbac.test', roleId('owner'));
    assert.ok(second.session.user.platformPermissions.includes('team.manage'));
    ok(await api.patch(`/api/v1/platform/team/${second.id}`).set(s.p).send({ roleId: roleId('admin') }));
    // Only one active owner is left: the service refuses to demote, deactivate or remove them.
    const ownerCtx = { userId: second.id, user: { platformRole: 'super_admin', platformPermissions: s.owner.user.platformPermissions } };
    await assert.rejects(team.changeRole(ownerCtx, s.owner.user._id, roleId('viewer')), (e) => e.status === 409);
    await assert.rejects(team.setActive(ownerCtx, s.owner.user._id, false), (e) => e.status === 409);
    await assert.rejects(team.removeMember(ownerCtx, s.owner.user._id), (e) => e.status === 409);
  });

  test('a deactivated member cannot log in; reactivation restores access', async () => {
    ok(await api.post(`/api/v1/platform/team/${s.viewer.id}/deactivate`).set(s.p));
    const res = await login('viewer@rbac.test', NEW_PASSWORD);
    assert.equal(res.status, 403);
    assert.equal(res.body.error?.code || res.body.code, 'PLATFORM_ACCESS_OFF');
    assert.equal((await api.get('/api/v1/platform/stats').set(s.viewer.h)).status, 401, 'open session stops at once');
    assert.equal((await api.post('/api/v1/auth/refresh').send({ refreshToken: s.viewer.session.refreshToken })).status, 401);
    const list = await api.get('/api/v1/platform/team?status=inactive').set(s.p);
    assert.deepEqual(list.body.data.map((m) => m.email), ['viewer@rbac.test']);

    ok(await api.post(`/api/v1/platform/team/${s.viewer.id}/reactivate`).set(s.p));
    const again = await login('viewer@rbac.test', NEW_PASSWORD);
    ok(again);
    s.viewer.h = bearer(again.body.data.accessToken);
  });

  test('removing a member keeps the account but ends platform access', async () => {
    ok(await api.patch(`/api/v1/platform/team/${s.triage.id}`).set(s.p).send({ roleId: roleId('viewer') }));
    ok(await api.delete(`/api/v1/platform/roles/${s.triageRole}`).set(s.p), 204);
    ok(await api.delete(`/api/v1/platform/team/${s.triage.id}`).set(s.p), 204);
    const user = await models.User.findById(s.triage.id).lean();
    assert.ok(user, 'the user is not deleted');
    assert.equal(user.platformRole, undefined);
    const res = await login('triage@rbac.test', NEW_PASSWORD);
    assert.equal(res.status, 403);
  });

  test('inviting an existing team member is refused', async () => {
    const res = await api.post('/api/v1/platform/team').set(s.p).send({ name: 'Again', email: 'billing@rbac.test', roleId: roleId('viewer') });
    assert.equal(res.status, 409);
  });
});

describe('platform activity log', () => {
  test('records platform actions with actor and society', async () => {
    await new Promise((r) => setTimeout(r, 100)); // writes are fire-and-forget
    const res = await api.get('/api/v1/platform/activity?limit=100').set(s.p);
    ok(res);
    const actions = new Set(res.body.data.map((r) => r.action));
    for (const a of ['team.member_invited', 'role.created', 'role.updated', 'role.deleted', 'team.member_role_changed', 'team.member_deactivated', 'team.member_reactivated', 'team.member_removed',
      'society.updated', 'society.suspended', 'society.reactivated', 'society.features_changed', 'plan.price_updated', 'billing.run', 'support.replied', 'support.assigned', 'support.session_started']) {
      assert.ok(actions.has(a), `missing ${a}`);
    }
    const suspended = res.body.data.find((r) => r.action === 'society.suspended');
    assert.equal(suspended.actor.email, 'owner@rbac.test');
    assert.equal(suspended.society.name, 'Rbac Towers');
    assert.equal(suspended.details.suspendedReason, 'Testing');
    // Secrets never land in the log.
    assert.ok(!JSON.stringify(res.body.data).includes(NEW_PASSWORD));
  });

  test('filters by actor, action area, society and date range', async () => {
    const byBilling = await api.get(`/api/v1/platform/activity?actor=${s.billing.id}`).set(s.viewer.h);
    ok(byBilling);
    assert.ok(byBilling.body.data.length >= 2);
    assert.ok(byBilling.body.data.every((r) => r.actor._id === s.billing.id));

    const teamOnly = await api.get('/api/v1/platform/activity?action=team&limit=100').set(s.p);
    assert.ok(teamOnly.body.data.length > 0 && teamOnly.body.data.every((r) => r.action.startsWith('team.')));
    const exact = await api.get('/api/v1/platform/activity?action=billing.run').set(s.p);
    assert.equal(exact.body.data.length, 2);

    const soc = await api.get(`/api/v1/platform/activity?society=${s.societyId}&limit=100`).set(s.p);
    assert.ok(soc.body.data.length >= 5 && soc.body.data.every((r) => r.society?._id === s.societyId));

    const future = await api.get(`/api/v1/platform/activity?from=${new Date(Date.now() + 86400000).toISOString()}`).set(s.p);
    assert.equal(future.body.data.length, 0);
    const paged = await api.get('/api/v1/platform/activity?limit=2&page=2').set(s.p);
    assert.equal(paged.body.data.length, 2);
    assert.ok(paged.body.meta.total > 4);

    const actors = await api.get('/api/v1/platform/activity/actors').set(s.p);
    assert.ok(actors.body.data.some((a) => a.email === 'triage@rbac.test'), 'removed members still appear as actors');
    assert.equal((await models.PlatformAudit.countDocuments({ action: 'team.member_invited' })) >= 6, true);
  });
});
