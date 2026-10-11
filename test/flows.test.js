import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {}; // shared state across the flow

const login = async (identifier, password = 'Password@123') => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

before(async () => {
  api = await setup();
});
after(teardown);

describe('auth & onboarding', () => {
  test('registers a society with its first admin', async () => {
    const res = await api.post('/api/v1/auth/register-society').send({
      society: { name: 'Green Valley Residency', city: 'Pune' },
      admin: { name: 'Asha Admin', email: 'admin@gv.test', password: 'Password@123', designation: 'Secretary' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.user.role, 'admin');
    assert.match(res.body.data.user.society.code, /^[A-Z0-9]{6}$/);
    s.admin = res.body.data;
    s.code = res.body.data.user.society.code;
  });

  test('rejects bad login and validation errors', async () => {
    const bad = await api.post('/api/v1/auth/login').send({ identifier: 'admin@gv.test', password: 'wrong' });
    assert.equal(bad.status, 401);
    const invalid = await api.post('/api/v1/auth/register-society').send({ society: {}, admin: {} });
    assert.equal(invalid.status, 422);
    assert.ok(invalid.body.error.details.length > 0);
  });

  test('admin creates blocks and bulk units', async () => {
    const h = bearer(s.admin.accessToken);
    const block = await api.post('/api/v1/blocks').set(h).send({ name: 'a', floors: 3 });
    assert.equal(block.status, 201);
    assert.equal(block.body.data.name, 'A');
    s.blockId = block.body.data._id;
    const bulk = await api.post('/api/v1/units/bulk').set(h).send({ block: s.blockId, fromFloor: 1, toFloor: 3, unitsPerFloor: 2, areaSqft: 1000 });
    assert.equal(bulk.status, 201);
    assert.equal(bulk.body.data.inserted, 6);
    const again = await api.post('/api/v1/units/bulk').set(h).send({ block: s.blockId, fromFloor: 1, toFloor: 3, unitsPerFloor: 2 });
    assert.equal(again.body.data.skipped, 6);
    const units = await api.get('/api/v1/units?search=A-1').set(h);
    assert.equal(units.body.meta.total, 2);
    s.unit101 = units.body.data.find((u) => u.label === 'A-101')._id;
    s.unit102 = units.body.data.find((u) => u.label === 'A-102')._id;
  });

  test('resident joins with society code and admin approves', async () => {
    const lookup = await api.get(`/api/v1/auth/societies/${s.code}`);
    assert.equal(lookup.status, 200);
    assert.equal(lookup.body.data.units.length, 6);

    const join = await api.post('/api/v1/auth/join').send({
      societyCode: s.code, name: 'Ravi Resident', email: 'ravi@gv.test', password: 'Password@123', unit: s.unit101, residentType: 'owner',
    });
    assert.equal(join.status, 201);

    const pendingLogin = await api.post('/api/v1/auth/login').send({ identifier: 'ravi@gv.test', password: 'Password@123' });
    assert.equal(pendingLogin.status, 403);
    assert.equal(pendingLogin.body.error.code, 'PENDING_APPROVAL');

    const h = bearer(s.admin.accessToken);
    const pending = await api.get('/api/v1/users?status=pending').set(h);
    assert.equal(pending.body.data.length, 1);
    const approve = await api.post(`/api/v1/users/${pending.body.data[0]._id}/approve`).set(h);
    assert.equal(approve.body.data.status, 'active');
    s.resident = await login('ravi@gv.test');
    assert.equal(s.resident.user.unit.label, 'A-101');
  });

  test('admin creates staff accounts', async () => {
    const h = bearer(s.admin.accessToken);
    for (const [role, email] of [['guard', 'guard@gv.test'], ['accountant', 'acc@gv.test'], ['staff', 'plumber@gv.test'], ['resident', 'neha@gv.test']]) {
      const body = { name: `${role} user`, email, password: 'Password@123', role };
      if (role === 'resident') Object.assign(body, { unit: s.unit102, residentType: 'tenant' });
      // eslint-disable-next-line no-await-in-loop
      const res = await api.post('/api/v1/users').set(h).send(body);
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    s.guard = await login('guard@gv.test');
    s.accountant = await login('acc@gv.test');
    s.staff = await login('plumber@gv.test');
    s.resident2 = await login('neha@gv.test');
    const dup = await api.post('/api/v1/users').set(h).send({ name: 'Dup', email: 'guard@gv.test', password: 'Password@123', role: 'guard' });
    assert.equal(dup.status, 409);
  });

  test('refresh token rotates and reuse is rejected', async () => {
    const r1 = await api.post('/api/v1/auth/refresh').send({ refreshToken: s.resident.refreshToken });
    assert.equal(r1.status, 200);
    // immediate reuse (aborted reload / two tabs) is tolerated inside the grace window
    const race = await api.post('/api/v1/auth/refresh').send({ refreshToken: s.resident.refreshToken });
    assert.equal(race.status, 200);
    // after the grace window, reuse is treated as theft
    const { default: RefreshToken } = await import('../src/modules/auth/refreshToken.model.js');
    await RefreshToken.updateMany({ revokedAt: { $ne: null } }, { revokedAt: new Date(Date.now() - 5 * 60000) });
    const reuse = await api.post('/api/v1/auth/refresh').send({ refreshToken: s.resident.refreshToken });
    assert.equal(reuse.status, 401);
    // family revoked -> the rotated token is dead too
    const r2 = await api.post('/api/v1/auth/refresh').send({ refreshToken: r1.body.data.refreshToken });
    assert.equal(r2.status, 401);
    s.resident = await login('ravi@gv.test');
  });

  test('logout kills the session immediately', async () => {
    const sess = await login('ravi@gv.test');
    await api.post('/api/v1/auth/logout').send({ refreshToken: sess.refreshToken });
    const after = await api.post('/api/v1/auth/refresh').send({ refreshToken: sess.refreshToken });
    assert.equal(after.status, 401);
  });
});

describe('authorization & tenant isolation', () => {
  test('resident cannot use admin endpoints', async () => {
    const res = await api.post('/api/v1/blocks').set(bearer(s.resident.accessToken)).send({ name: 'Z' });
    assert.equal(res.status, 403);
    const noToken = await api.get('/api/v1/dashboard');
    assert.equal(noToken.status, 401);
  });

  test('another society cannot see this society data', async () => {
    const other = await api.post('/api/v1/auth/register-society').send({
      society: { name: 'Other Society' },
      admin: { name: 'Other Admin', email: 'other@os.test', password: 'Password@123' },
    });
    const h = bearer(other.body.data.accessToken);
    const units = await api.get('/api/v1/units').set(h);
    assert.equal(units.body.meta.total, 0);
    const unit = await api.get(`/api/v1/units/${s.unit101}`).set(h);
    assert.equal(unit.status, 404);
    const users = await api.get('/api/v1/users').set(h);
    assert.equal(users.body.data.length, 1);
  });
});

describe('gate & visitors', () => {
  test('guard logs visitor, resident approves, guard checks out', async () => {
    const entry = await api.post('/api/v1/visitors').set(bearer(s.guard.accessToken)).send({ unit: s.unit101, name: 'Courier Guy', purpose: 'delivery', company: 'Amazon' });
    assert.equal(entry.status, 201);
    assert.equal(entry.body.data.status, 'pending');

    const notes = await api.get('/api/v1/notifications').set(bearer(s.resident.accessToken));
    assert.ok(notes.body.data.some((n) => n.type === 'visitor'));

    const other = await api.post(`/api/v1/visitors/${entry.body.data._id}/approve`).set(bearer(s.resident2.accessToken)).send({});
    assert.equal(other.status, 404, 'resident of another unit must not approve');

    const ok = await api.post(`/api/v1/visitors/${entry.body.data._id}/approve`).set(bearer(s.resident.accessToken)).send({});
    assert.equal(ok.body.data.status, 'checked_in');
    const twice = await api.post(`/api/v1/visitors/${entry.body.data._id}/deny`).set(bearer(s.resident.accessToken)).send({});
    assert.equal(twice.status, 409);

    const out = await api.post(`/api/v1/visitors/${entry.body.data._id}/check-out`).set(bearer(s.guard.accessToken));
    assert.equal(out.body.data.status, 'checked_out');
  });

  test('pre-approved pass is single use', async () => {
    const now = Date.now();
    const pass = await api.post('/api/v1/visitors/passes').set(bearer(s.resident.accessToken)).send({
      guestName: 'Cousin', validFrom: new Date(now - 60000).toISOString(), validTo: new Date(now + 3600000).toISOString(),
    });
    assert.equal(pass.status, 201);
    assert.match(pass.body.data.code, /^\d{6}$/);
    const use = await api.post('/api/v1/visitors/passes/verify').set(bearer(s.guard.accessToken)).send({ code: pass.body.data.code });
    assert.equal(use.status, 201);
    assert.equal(use.body.data.unit.label, 'A-101');
    const reuse = await api.post('/api/v1/visitors/passes/verify').set(bearer(s.guard.accessToken)).send({ code: pass.body.data.code });
    assert.equal(reuse.status, 404);
  });

  test('daily help gate scan toggles in and out', async () => {
    const help = await api.post('/api/v1/daily-help').set(bearer(s.resident.accessToken)).send({ name: 'Sunita', phone: '9876543210', type: 'maid' });
    assert.equal(help.status, 201);
    const g = bearer(s.guard.accessToken);
    const inn = await api.post('/api/v1/daily-help/gate-scan').set(g).send({ passcode: help.body.data.passcode });
    assert.equal(inn.body.data.direction, 'in');
    const out = await api.post('/api/v1/daily-help/gate-scan').set(g).send({ passcode: help.body.data.passcode });
    assert.equal(out.body.data.direction, 'out');
    const att = await api.get(`/api/v1/daily-help/${help.body.data._id}/attendance`).set(bearer(s.resident.accessToken));
    assert.equal(att.body.data.length, 1);
    assert.ok(att.body.data[0].outAt);
    // second household with same phone gets linked, not duplicated
    const linked = await api.post('/api/v1/daily-help').set(bearer(s.resident2.accessToken)).send({ name: 'Sunita', phone: '9876543210' });
    assert.equal(linked.body.data._id, help.body.data._id);
    assert.equal(linked.body.data.units.length, 2);
  });

  test('SOS raise, acknowledge, resolve', async () => {
    const sos = await api.post('/api/v1/sos').set(bearer(s.resident.accessToken)).send({ type: 'medical', message: 'Need help' });
    assert.equal(sos.status, 201);
    const ack = await api.post(`/api/v1/sos/${sos.body.data._id}/acknowledge`).set(bearer(s.guard.accessToken));
    assert.equal(ack.body.data.status, 'acknowledged');
    const res = await api.post(`/api/v1/sos/${sos.body.data._id}/resolve`).set(bearer(s.guard.accessToken)).send({ resolutionNote: 'Ambulance came' });
    assert.equal(res.body.data.status, 'resolved');
  });
});

describe('billing & payments', () => {
  test('configure billing and generate bills', async () => {
    const settings = await api.patch('/api/v1/society/me/settings').set(bearer(s.admin.accessToken)).send({
      billing: { perSqftRate: 300, fixedAmount: 50000, chargeHeads: [{ name: 'Sinking fund', amount: 20000 }], lateFeeType: 'percent', lateFeeValue: 10 },
    });
    assert.equal(settings.status, 200);
    assert.equal(settings.body.data.settings.billing.dueDays, 15, 'sibling settings must survive partial update');

    const gen = await api.post('/api/v1/bills/generate').set(bearer(s.accountant.accessToken)).send({ period: '2026-10' });
    assert.equal(gen.status, 201, JSON.stringify(gen.body));
    assert.equal(gen.body.data.created, 6);
    const again = await api.post('/api/v1/bills/generate').set(bearer(s.accountant.accessToken)).send({ period: '2026-10' });
    assert.equal(again.body.data.created, 0);

    const mine = await api.get('/api/v1/bills').set(bearer(s.resident.accessToken));
    assert.equal(mine.body.data.length, 1);
    // 1000 sqft * ₹3 + ₹500 fixed + ₹200 sinking fund = ₹3700
    assert.equal(mine.body.data[0].total, 370000);
    s.bill = mine.body.data[0];
  });

  test('partial offline payment then online payment settles the bill', async () => {
    const off = await api.post('/api/v1/payments/offline').set(bearer(s.accountant.accessToken)).send({ bill: s.bill._id, amount: 100000, method: 'cash' });
    assert.equal(off.status, 201, JSON.stringify(off.body));
    assert.match(off.body.data.receiptNumber, /^RCPT-/);

    const over = await api.post('/api/v1/payments/offline').set(bearer(s.accountant.accessToken)).send({ bill: s.bill._id, amount: 999999, method: 'cash' });
    assert.equal(over.status, 400);

    const r = bearer(s.resident.accessToken);
    const order = await api.post('/api/v1/payments/orders').set(r).send({ bill: s.bill._id });
    assert.equal(order.body.data.amount, 270000);
    const forged = await api.post('/api/v1/payments/verify').set(r).send({ orderId: order.body.data.orderId, paymentId: 'mock_pay_x', signature: 'deadbeefdeadbeef' });
    assert.equal(forged.status, 400);

    const order2 = await api.post('/api/v1/payments/orders').set(r).send({ bill: s.bill._id });
    const signed = await api.post('/api/v1/payments/mock/sign').set(r).send({ orderId: order2.body.data.orderId });
    const verify = await api.post('/api/v1/payments/verify').set(r).send(signed.body.data);
    assert.equal(verify.status, 200, JSON.stringify(verify.body));

    const bill = await api.get(`/api/v1/bills/${s.bill._id}`).set(r);
    assert.equal(bill.body.data.status, 'paid');
    assert.equal(bill.body.data.balance, 0);
    assert.equal(bill.body.data.payments.length, 2);

    const receipt = await api.get(`/api/v1/payments/${verify.body.data._id}/receipt`).set(r);
    assert.equal(receipt.body.data.society.name, 'Green Valley Residency');
  });

  test('late fees and defaulters', async () => {
    const gen = await api.post('/api/v1/bills/generate').set(bearer(s.accountant.accessToken)).send({ period: '2026-09', dueDate: '2026-09-15' });
    assert.equal(gen.body.data.created, 6);
    const fees = await api.post('/api/v1/bills/apply-late-fees').set(bearer(s.accountant.accessToken));
    assert.equal(fees.body.data.updated, 6);
    const again = await api.post('/api/v1/bills/apply-late-fees').set(bearer(s.accountant.accessToken));
    assert.equal(again.body.data.updated, 0, 'late fee applies once');
    const def = await api.get('/api/v1/bills/defaulters').set(bearer(s.accountant.accessToken));
    assert.equal(def.body.data.length, 6);
    assert.equal(def.body.data[0].outstanding, 407000); // 3700 + 10%
  });
});

describe('helpdesk', () => {
  test('complaint lifecycle with SLA, assignment, comments and rating', async () => {
    const r = bearer(s.resident.accessToken);
    const c = await api.post('/api/v1/complaints').set(r).send({ category: 'plumbing', priority: 'high', title: 'Kitchen tap leaking' });
    assert.equal(c.status, 201);
    assert.match(c.body.data.ticketNumber, /^CMP-\d{6}$/);
    const hours = (new Date(c.body.data.slaDueAt) - new Date(c.body.data.createdAt)) / 3600000;
    assert.ok(Math.abs(hours - 24) < 0.1);

    const a = bearer(s.admin.accessToken);
    const assign = await api.post(`/api/v1/complaints/${c.body.data._id}/assign`).set(a).send({ assignedTo: s.staff.user._id });
    assert.equal(assign.body.data.status, 'assigned');

    const st = bearer(s.staff.accessToken);
    const mine = await api.get('/api/v1/complaints').set(st);
    assert.equal(mine.body.data.length, 1);
    await api.post(`/api/v1/complaints/${c.body.data._id}/comments`).set(st).send({ text: 'Internal: need washer', internal: true });
    await api.post(`/api/v1/complaints/${c.body.data._id}/comments`).set(st).send({ text: 'Coming at 5pm' });
    const progress = await api.post(`/api/v1/complaints/${c.body.data._id}/status`).set(st).send({ status: 'in_progress' });
    assert.equal(progress.body.data.status, 'in_progress');
    const closeByStaff = await api.post(`/api/v1/complaints/${c.body.data._id}/status`).set(st).send({ status: 'closed' });
    assert.equal(closeByStaff.status, 403);
    await api.post(`/api/v1/complaints/${c.body.data._id}/status`).set(st).send({ status: 'resolved' });

    const view = await api.get(`/api/v1/complaints/${c.body.data._id}`).set(r);
    assert.equal(view.body.data.comments.length, 1, 'internal comments hidden from resident');

    const rated = await api.post(`/api/v1/complaints/${c.body.data._id}/rate`).set(r).send({ rating: 5, feedback: 'Quick' });
    assert.equal(rated.body.data.status, 'closed');

    const stats = await api.get('/api/v1/complaints/stats').set(a);
    assert.equal(stats.body.data.avgRating, 5);
  });
});

describe('community', () => {
  test('notices respect audience targeting', async () => {
    const a = bearer(s.admin.accessToken);
    await api.post('/api/v1/notices').set(a).send({ title: 'Water cut tomorrow', body: '10am-2pm', category: 'maintenance' });
    await api.post('/api/v1/notices').set(a).send({ title: 'Guards meeting', body: 'Shift change', audience: { type: 'roles', roles: ['guard'] } });
    const res = await api.get('/api/v1/notices').set(bearer(s.resident.accessToken));
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].isRead, false);
    await api.post(`/api/v1/notices/${res.body.data[0]._id}/read`).set(bearer(s.resident.accessToken));
    const guardView = await api.get('/api/v1/notices').set(bearer(s.guard.accessToken));
    assert.equal(guardView.body.data.length, 2);
  });

  test('polls allow one vote per household', async () => {
    const poll = await api.post('/api/v1/polls').set(bearer(s.admin.accessToken)).send({ question: 'Paint the gate blue?', options: ['Yes', 'No'] });
    assert.equal(poll.status, 201);
    const v = await api.post(`/api/v1/polls/${poll.body.data._id}/vote`).set(bearer(s.resident.accessToken)).send({ optionIndex: 0 });
    assert.equal(v.body.data.options[0].votes, 1);
    assert.equal(v.body.data.myVote, 0);
    const twice = await api.post(`/api/v1/polls/${poll.body.data._id}/vote`).set(bearer(s.resident.accessToken)).send({ optionIndex: 1 });
    assert.equal(twice.status, 409);
  });

  test('amenity booking enforces capacity and approval', async () => {
    const a = bearer(s.admin.accessToken);
    const gym = await api.post('/api/v1/amenities').set(a).send({ name: 'Party Hall', capacity: 1, openTime: '09:00', closeTime: '21:00', slotMinutes: 120, requiresApproval: true });
    assert.equal(gym.status, 201);
    const date = new Date(Date.now() + 2 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const avail = await api.get(`/api/v1/amenities/${gym.body.data._id}/availability?date=${date}`).set(bearer(s.resident.accessToken));
    assert.equal(avail.body.data.slots.length, 6);

    const b1 = await api.post('/api/v1/bookings').set(bearer(s.resident.accessToken)).send({ amenity: gym.body.data._id, date, startTime: '09:00', endTime: '11:00' });
    assert.equal(b1.status, 201);
    assert.equal(b1.body.data.status, 'pending');
    const clash = await api.post('/api/v1/bookings').set(bearer(s.resident2.accessToken)).send({ amenity: gym.body.data._id, date, startTime: '10:00', endTime: '12:00' });
    assert.equal(clash.status, 409);
    const outside = await api.post('/api/v1/bookings').set(bearer(s.resident2.accessToken)).send({ amenity: gym.body.data._id, date, startTime: '07:00', endTime: '08:00' });
    assert.equal(outside.status, 400);

    const decided = await api.post(`/api/v1/bookings/${b1.body.data._id}/decide`).set(a).send({ approve: true });
    assert.equal(decided.body.data.status, 'confirmed');
  });
});

describe('dashboards & audit', () => {
  test('each role gets its dashboard', async () => {
    const admin = await api.get('/api/v1/dashboard').set(bearer(s.admin.accessToken));
    assert.equal(admin.body.data.view, 'management');
    assert.equal(admin.body.data.units, 6);
    const res = await api.get('/api/v1/dashboard').set(bearer(s.resident.accessToken));
    assert.equal(res.body.data.view, 'resident');
    const guard = await api.get('/api/v1/dashboard').set(bearer(s.guard.accessToken));
    assert.equal(guard.body.data.view, 'guard');
  });

  test('audit log records admin and finance actions', async () => {
    const logs = await api.get('/api/v1/audit-logs?limit=100').set(bearer(s.admin.accessToken));
    const actions = new Set(logs.body.data.map((l) => l.action));
    for (const a of ['member.approved', 'bill.generated', 'payment.recorded', 'unit.bulk_created']) assert.ok(actions.has(a), a);
  });

  test('NoSQL operator injection is stripped', async () => {
    const res = await api.post('/api/v1/auth/login').send({ identifier: { $ne: null }, password: { $ne: null } });
    assert.equal(res.status, 422);
  });
});
