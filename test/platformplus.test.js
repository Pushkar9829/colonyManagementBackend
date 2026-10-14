import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
const DAY = 86400000;
const PASSWORD = 'Password@123';

// Collects a binary response body (PDF / XLSX) into a Buffer.
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const login = async (identifier) => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password: PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

async function newSociety(name, adminEmail) {
  const reg = await api.post('/api/v1/auth/register-society').send({ society: { name }, admin: { name: `${name} Admin`, email: adminEmail, password: PASSWORD } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const admin = reg.body.data;
  const h = bearer(admin.accessToken);
  const block = await api.post('/api/v1/blocks').set(h).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 3, areaSqft: 1000 });
  const units = (await api.get('/api/v1/units').set(h)).body.data;
  await api.patch('/api/v1/society/me/settings').set(h).send({ billing: { fixedAmount: 100000 } });
  return { admin, h, id: admin.user.society._id, code: admin.user.society.code, units };
}

async function addMember(soc, body) {
  const res = await api.post('/api/v1/users').set(soc.h).send({ password: PASSWORD, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

let models;
let jobs;

before(async () => {
  api = await setup();
  models = {
    User: (await import('../src/modules/users/user.model.js')).default,
    Society: (await import('../src/modules/society/society.model.js')).default,
    PlatformInvoice: (await import('../src/modules/subscriptions/platformInvoice.model.js')).default,
    Subscription: (await import('../src/modules/subscriptions/subscription.model.js')).default,
    Bill: (await import('../src/modules/billing/bill.model.js')).default,
    Payment: (await import('../src/modules/payments/payment.model.js')).default,
    Notification: (await import('../src/modules/notifications/notification.model.js')).default,
  };
  jobs = {
    subscriptions: await import('../src/modules/subscriptions/subscriptions.service.js'),
    support: await import('../src/modules/support/support.service.js'),
    reports: await import('../src/modules/reports/reports.service.js'),
  };

  s.one = await newSociety('Alpha Towers', 'admin1@pp.test');
  s.two = await newSociety('Beta Residency', 'admin2@pp.test');
  s.three = await newSociety('Gamma Heights', 'admin3@pp.test');
  // New societies start on a 30-day trial; these tests were written for the free plan, so start there.
  await models.Society.updateMany({}, { $set: { plan: { name: 'free', unitLimit: 50 } } });

  await models.User.create({ name: 'Owner', email: 'owner@pp.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'super_admin' });
  s.owner = await login('owner@pp.test');
  s.p = bearer(s.owner.accessToken);

  s.resident1 = await addMember(s.one, { name: 'Ravi', email: 'ravi@pp.test', role: 'resident', unit: s.one.units[0]._id, residentType: 'owner' });
  s.resident1b = await addMember(s.one, { name: 'Neha', email: 'neha@pp.test', role: 'resident', unit: s.one.units[1]._id, residentType: 'tenant' });
  s.fm = await addMember(s.one, { name: 'Meera FM', email: 'fm@pp.test', role: 'facility_manager' });
  s.acc = await addMember(s.one, { name: 'Rohit Acc', email: 'acc@pp.test', role: 'accountant' });
  s.ravi = await login('ravi@pp.test');
  s.neha = await login('neha@pp.test');
  s.fmSession = await login('fm@pp.test');
  s.accSession = await login('acc@pp.test');
});
after(teardown);

describe('subscriptions: plans, invoices, GST', () => {
  test('price list is platform-only and editable', async () => {
    const forbidden = await api.get('/api/v1/platform/plans').set(s.one.h);
    assert.equal(forbidden.status, 403, 'society admins cannot read platform pricing');
    const list = await api.get('/api/v1/platform/plans').set(s.p);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((p) => p.plan), ['free', 'basic', 'standard', 'premium']);
    const upd = await api.put('/api/v1/platform/plans/basic').set(s.p).send({ perUnitMonthly: 2000, flatMonthly: 10000 });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.equal(upd.body.data.perUnitMonthly, 2000);
    assert.equal(upd.body.data.custom, true);
    const bad = await api.put('/api/v1/platform/plans/gold').set(s.p).send({ perUnitMonthly: 1 });
    assert.equal(bad.status, 422);
  });

  test('computeCharge: units × rate + flat, yearly discount, 18% GST', () => {
    const { computeCharge } = jobs.subscriptions;
    const m = computeCharge({ units: 10, price: { perUnitMonthly: 1000, flatMonthly: 5000, yearlyDiscountPercent: 10 }, cycle: 'monthly' });
    assert.equal(m.subtotal, 15000);
    assert.equal(m.gst, 2700);
    assert.equal(m.total, 17700);
    const y = computeCharge({ units: 10, price: { perUnitMonthly: 1000, flatMonthly: 5000, yearlyDiscountPercent: 10 }, cycle: 'yearly' });
    assert.equal(y.months, 12);
    assert.equal(y.subtotal, 162000); // (10000 + 5000) × 12 = 180000 less 10%
    assert.equal(y.gst, 29160);
    assert.equal(y.total, 191160);
  });

  test('the invoice job bills paying societies once per period', async () => {
    await api.patch(`/api/v1/platform/societies/${s.one.id}`).set(s.p).send({ plan: { name: 'basic' } });
    await api.patch(`/api/v1/platform/societies/${s.three.id}`).set(s.p).send({ plan: { name: 'standard' } });
    const r = await jobs.subscriptions.generateDueInvoices();
    assert.equal(r.created, 2, 'two paying societies, free one skipped');

    const again = await jobs.subscriptions.generateDueInvoices();
    assert.equal(again.created, 0, 'period already billed');

    const one = await models.PlatformInvoice.findOne({ society: s.one.id }).lean();
    assert.match(one.number, /^PINV-\d{6}$/);
    assert.equal(one.units, 3);
    assert.equal(one.subtotal, 3 * 2000 + 10000);
    assert.equal(one.gstRate, 18);
    assert.equal(one.gst, 2880);
    assert.equal(one.total, 18880);
    assert.equal(one.status, 'unpaid');
    assert.equal(Math.round((one.dueDate - one.periodStart) / DAY), 10, 'due 10 days after the period starts');
    const three = await models.PlatformInvoice.findOne({ society: s.three.id }).lean();
    assert.equal(three.total, Math.round((3 * 1500 + 50000) * 1.18));
    assert.equal(await models.PlatformInvoice.countDocuments({ society: s.two.id }), 0);
    s.inv1 = one;
    s.inv3 = three;
  });

  test('society admins see their own invoices (and only theirs) with a PDF', async () => {
    const me = await api.get('/api/v1/subscription').set(s.one.h);
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.data.outstanding, 18880);
    assert.equal(me.body.data.price.plan, 'basic');
    const list = await api.get('/api/v1/subscription/invoices').set(s.one.h);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].payToken, undefined, 'pay token never listed');

    const other = await api.get(`/api/v1/subscription/invoices/${s.inv1._id}`).set(s.two.h);
    assert.equal(other.status, 404, 'tenant isolation');
    const detail = await api.get(`/api/v1/subscription/invoices/${s.inv1._id}`).set(s.one.h);
    assert.match(detail.body.data.payLink, /\/subscription\/pay\//);

    const pdf = await api.get(`/api/v1/subscription/invoices/${s.inv1._id}/pdf`).set(s.one.h).buffer(true).parse(binary);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers['content-type'], /application\/pdf/);
    assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');

    const resident = await api.get('/api/v1/subscription').set(bearer(s.ravi.accessToken));
    assert.equal(resident.status, 403);
    const acc = await api.get('/api/v1/subscription/invoices').set(bearer(s.accSession.accessToken));
    assert.equal(acc.status, 200, 'accountant can view platform invoices');
  });

  test('online payment with the mock provider marks the invoice paid and extends paid-until', async () => {
    const h = s.three.h;
    const order = await api.post(`/api/v1/subscription/invoices/${s.inv3._id}/order`).set(h);
    assert.equal(order.status, 200, JSON.stringify(order.body));
    assert.equal(order.body.data.amount, s.inv3.total);
    const bogus = await api.post('/api/v1/subscription/verify').set(h).send({ orderId: order.body.data.orderId, paymentId: 'x', signature: 'nope' });
    assert.equal(bogus.status, 400);

    const order2 = await api.post(`/api/v1/subscription/invoices/${s.inv3._id}/order`).set(h);
    const signed = await api.post('/api/v1/subscription/mock/sign').set(h).send({ orderId: order2.body.data.orderId });
    const ok = await api.post('/api/v1/subscription/verify').set(h).send(signed.body.data);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.invoice.status, 'paid');
    const again = await api.post('/api/v1/subscription/verify').set(h).send(signed.body.data);
    assert.equal(again.status, 200, 'verify is idempotent');

    const society = await models.Society.findById(s.three.id).lean();
    assert.equal(society.plan.validUntil.getTime(), new Date(s.inv3.periodEnd).getTime(), 'Society.plan.validUntil follows the paid period');
    const sub = await models.Subscription.findOne({ society: s.three.id }).lean();
    assert.equal(sub.paidUntil.getTime(), new Date(s.inv3.periodEnd).getTime());
    const payAgain = await api.post(`/api/v1/subscription/invoices/${s.inv3._id}/order`).set(h);
    assert.equal(payAgain.status, 409, 'paid invoices cannot be paid twice');
    const otherSociety = await api.post('/api/v1/subscription/verify').set(s.one.h).send(signed.body.data);
    assert.equal(otherSociety.status, 404, 'another society cannot verify this order');
  });
});

describe('subscriptions: dunning, grace period, suspension', () => {
  test('reminders before and after due, then auto-suspend after the grace period', async () => {
    const due = new Date(s.inv1.dueDate).getTime();
    const before = await jobs.subscriptions.runDunning(new Date(due - 2 * DAY));
    assert.ok(before.reminded >= 1);
    const stillBefore = await jobs.subscriptions.runDunning(new Date(due - 1 * DAY));
    const inv = await models.PlatformInvoice.findById(s.inv1._id).lean();
    assert.equal(inv.reminders.filter((r) => r.stage === 'before').length, 1, 'the before-due reminder is sent once');
    assert.equal(stillBefore.suspended, 0);

    await jobs.subscriptions.runDunning(new Date(due + 1 * DAY));
    const sub = await models.Subscription.findOne({ society: s.one.id }).lean();
    assert.equal(sub.status, 'past_due');
    assert.equal((await models.Society.findById(s.one.id).lean()).active, true, 'still inside the 7-day grace period');

    const notes = await models.Notification.countDocuments({ society: s.one.id, type: 'subscription' });
    assert.ok(notes >= 2, 'admins get in-app reminders');

    const late = await jobs.subscriptions.runDunning(new Date(due + 8 * DAY));
    assert.equal(late.suspended, 1);
    const society = await models.Society.findById(s.one.id).lean();
    assert.equal(society.active, false);
    assert.match(society.suspendedReason, /PINV-/);
    const locked = await api.get('/api/v1/dashboard').set(s.one.h);
    assert.equal(locked.status, 403);
    assert.equal(locked.body.error.code, 'SOCIETY_SUSPENDED');

    const twice = await jobs.subscriptions.runDunning(new Date(due + 9 * DAY));
    assert.equal(twice.suspended, 0, 'suspends once per invoice');
  });

  test('paying through the pay link reactivates a suspended society', async () => {
    const { payToken } = await models.PlatformInvoice.findById(s.inv1._id).select('+payToken').lean();
    const bad = await api.get('/api/v1/subscription/pay/not-a-real-token-123456');
    assert.equal(bad.status, 404);
    const info = await api.get(`/api/v1/subscription/pay/${payToken}`);
    assert.equal(info.status, 200, JSON.stringify(info.body));
    assert.equal(info.body.data.society.active, false);
    assert.equal(info.body.data.invoice.payToken, undefined);

    const order = await api.post(`/api/v1/subscription/pay/${payToken}/order`);
    assert.equal(order.status, 200, JSON.stringify(order.body));
    const signed = await api.post(`/api/v1/subscription/pay/${payToken}/mock-sign`).send({ orderId: order.body.data.orderId });
    const paid = await api.post(`/api/v1/subscription/pay/${payToken}/verify`).send(signed.body.data);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.reactivated, true);

    const society = await models.Society.findById(s.one.id).lean();
    assert.equal(society.active, true);
    assert.equal(society.suspendedReason, undefined);
    assert.equal(society.plan.validUntil.getTime(), new Date(s.inv1.periodEnd).getTime());
    const sub = await models.Subscription.findOne({ society: s.one.id }).lean();
    assert.equal(sub.status, 'active');
    const back = await api.get('/api/v1/dashboard').set(s.one.h);
    assert.equal(back.status, 200);
  });

  test('a manual platform suspension is not lifted by a payment', async () => {
    const sub = await models.Subscription.findOne({ society: s.one.id }).lean();
    // next period's invoice
    await jobs.subscriptions.generateDueInvoices(new Date(sub.billedUntil.getTime() + 3600000));
    const next = await models.PlatformInvoice.findOne({ society: s.one.id, status: 'unpaid' }).lean();
    assert.ok(next, 'second period invoiced');
    assert.notEqual(next.number, s.inv1.number);

    await api.patch(`/api/v1/platform/societies/${s.one.id}`).set(s.p).send({ active: false, suspendedReason: 'Fraud check' });
    const paid = await api.post(`/api/v1/platform/invoices/${next._id}/mark-paid`).set(s.p).send({ method: 'bank', reference: 'UTR123' });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.reactivated, false);
    assert.equal((await models.Society.findById(s.one.id).lean()).active, false);
    await api.patch(`/api/v1/platform/societies/${s.one.id}`).set(s.p).send({ active: true });
  });

  test('platform console: list, summary, void, grace-period settings', async () => {
    const list = await api.get('/api/v1/platform/invoices').set(s.p);
    assert.equal(list.status, 200);
    assert.ok(list.body.data.every((i) => i.society?.name));
    const summary = await api.get('/api/v1/platform/invoices/summary').set(s.p);
    assert.ok(summary.body.data.paid.count >= 3);

    const sub = await models.Subscription.findOne({ society: s.three.id }).lean();
    await jobs.subscriptions.generateDueInvoices(new Date(sub.billedUntil.getTime() + 3600000));
    const open = await models.PlatformInvoice.findOne({ society: s.three.id, status: 'unpaid' }).lean();
    const voided = await api.post(`/api/v1/platform/invoices/${open._id}/void`).set(s.p).send({ reason: 'Goodwill waiver' });
    assert.equal(voided.body.data.status, 'void');
    const payVoid = await api.post(`/api/v1/platform/invoices/${open._id}/mark-paid`).set(s.p).send({ method: 'upi' });
    assert.equal(payVoid.status, 409);

    const cfg = await api.patch(`/api/v1/platform/subscriptions/${s.three.id}`).set(s.p).send({ graceDays: 14, billingCycle: 'yearly' });
    assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
    assert.equal(cfg.body.data.subscription.graceDays, 14);
    assert.equal(cfg.body.data.nextInvoice.months, 12);
    const adminTry = await api.patch(`/api/v1/platform/subscriptions/${s.three.id}`).set(s.three.h).send({ graceDays: 90 });
    assert.equal(adminTry.status, 403);
    const own = await api.patch('/api/v1/subscription').set(s.three.h).send({ billingEmail: 'accounts@gamma.test', gstin: '27ABCDE1234F1Z5' });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.data.subscription.gstin, '27ABCDE1234F1Z5');
  });
});

describe('support tickets', () => {
  test('society raises, platform replies, both sides are notified', async () => {
    const created = await api.post('/api/v1/support/tickets').set(s.one.h).send({ category: 'billing', priority: 'high', subject: 'Invoice shows wrong unit count', description: 'We have 3 units' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.data.number, /^SUP-\d{6}$/);
    assert.ok(created.body.data.slaDueAt);
    assert.equal(created.body.data.awaiting, 'platform');
    s.ticket = created.body.data;

    const fmTicket = await api.post('/api/v1/support/tickets').set(bearer(s.fmSession.accessToken)).send({ category: 'technical', subject: 'Gate app is slow' });
    assert.equal(fmTicket.status, 201);
    const fmList = await api.get('/api/v1/support/tickets').set(bearer(s.fmSession.accessToken));
    assert.equal(fmList.body.data.length, 1, 'FM sees only tickets they raised');
    const adminList = await api.get('/api/v1/support/tickets').set(s.one.h);
    assert.equal(adminList.body.data.length, 2, 'admin sees all of the society');
    const resident = await api.post('/api/v1/support/tickets').set(bearer(s.ravi.accessToken)).send({ category: 'other', subject: 'Hello there' });
    assert.equal(resident.status, 403);
    const otherSoc = await api.get(`/api/v1/support/tickets/${s.ticket._id}`).set(s.two.h);
    assert.equal(otherSoc.status, 404);

    const consoleList = await api.get('/api/v1/platform/support/tickets?awaiting=platform').set(s.p);
    assert.equal(consoleList.status, 200);
    assert.ok(consoleList.body.data.some((t) => t._id === s.ticket._id && t.society.name === 'Alpha Towers'));
    const adminConsole = await api.get('/api/v1/platform/support/tickets').set(s.one.h);
    assert.equal(adminConsole.status, 403);

    const reply = await api.post(`/api/v1/platform/support/tickets/${s.ticket._id}/messages`).set(s.p).send({ text: 'Looking into it — could you confirm the block names?' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.data.status, 'waiting_on_customer');
    assert.equal(reply.body.data.awaiting, 'society');
    assert.ok(reply.body.data.firstResponseAt);
    assert.equal(reply.body.data.assignedTo.name, 'Owner');
    const inbox = await api.get('/api/v1/notifications').set(s.one.h);
    assert.ok(inbox.body.data.some((n) => n.type === 'support'), 'society admin notified in-app');

    const back = await api.post(`/api/v1/support/tickets/${s.ticket._id}/messages`).set(s.one.h).send({ text: 'Block A only.' });
    assert.equal(back.body.data.status, 'in_progress');
    assert.equal(back.body.data.awaiting, 'platform');
    assert.equal(back.body.data.messages.length, 2);

    const resolved = await api.post(`/api/v1/platform/support/tickets/${s.ticket._id}/status`).set(s.p).send({ status: 'resolved', note: 'Fixed the count' });
    assert.equal(resolved.body.data.status, 'resolved');
    const closed = await api.post(`/api/v1/support/tickets/${s.ticket._id}/close`).set(s.one.h).send({ rating: 5 });
    assert.equal(closed.body.data.status, 'closed');
    assert.equal(closed.body.data.rating, 5);
    const replyClosed = await api.post(`/api/v1/support/tickets/${s.ticket._id}/messages`).set(s.one.h).send({ text: 'one more thing' });
    assert.equal(replyClosed.status, 409);
    const reopened = await api.post(`/api/v1/support/tickets/${s.ticket._id}/reopen`).set(s.one.h).send({ note: 'Still wrong on the PDF' });
    assert.equal(reopened.body.data.status, 'open');
  });

  test('first-response SLA breaches are escalated once', async () => {
    const urgent = await api.post('/api/v1/support/tickets').set(s.two.h).send({ category: 'technical', priority: 'urgent', subject: 'Nobody can log in' });
    const due = new Date(urgent.body.data.slaDueAt).getTime();
    const r = await jobs.support.slaEscalations(new Date(due + 60000));
    assert.ok(r.escalated >= 1);
    const again = await jobs.support.slaEscalations(new Date(due + 120000));
    assert.equal(again.escalated, 0);
    const stats = await api.get('/api/v1/platform/support/stats').set(s.p);
    assert.ok(stats.body.data.awaitingPlatform >= 1);
  });
});

describe('feature flags', () => {
  test('defaults follow the plan, platform overrides win, null resets', async () => {
    const free = await api.get('/api/v1/features').set(s.two.h);
    assert.equal(free.status, 200);
    assert.equal(free.body.data.plan, 'free');
    assert.deepEqual(free.body.data.enabled, [], 'free = core only');
    const basic = await api.get('/api/v1/features').set(bearer(s.ravi.accessToken));
    assert.equal(basic.status, 200, 'any member may read');
    assert.ok(basic.body.data.enabled.includes('parking'));
    assert.ok(!basic.body.data.enabled.includes('chat'));

    const adminTry = await api.put(`/api/v1/platform/societies/${s.one.id}/features`).set(s.one.h).send({ overrides: { chat: true } });
    assert.equal(adminTry.status, 403);
    const unknown = await api.put(`/api/v1/platform/societies/${s.one.id}/features`).set(s.p).send({ overrides: { teleport: true } });
    assert.equal(unknown.status, 422);
    const set = await api.put(`/api/v1/platform/societies/${s.one.id}/features`).set(s.p).send({ overrides: { chat: true, parking: false, builder: true }, note: 'pilot' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const chat = set.body.data.features.find((f) => f.key === 'chat');
    assert.equal(chat.enabled, true);
    assert.equal(chat.source, 'override');
    const after = await api.get('/api/v1/features').set(s.one.h);
    assert.ok(after.body.data.enabled.includes('chat'));
    assert.ok(!after.body.data.enabled.includes('parking'));

    const reset = await api.put(`/api/v1/platform/societies/${s.one.id}/features`).set(s.p).send({ overrides: { parking: null } });
    assert.equal(reset.body.data.features.find((f) => f.key === 'parking').enabled, true, 'back to the plan default');
    const cat = await api.get('/api/v1/platform/features/catalogue').set(s.p);
    assert.equal(cat.body.data.features.length, 17);
  });

  test('requireFeature middleware gates a router', async () => {
    const { authenticate, requireSociety } = await import('../src/common/middleware/auth.js');
    const { requireFeature } = await import('../src/modules/features/requireFeature.js');
    const { errorHandler } = await import('../src/common/middleware/errorHandler.js');
    const { default: request } = await import('supertest');
    assert.throws(() => requireFeature('teleport'), /unknown feature/);

    const app = express();
    app.get('/chat', authenticate, requireSociety, requireFeature('chat'), (_req, res) => res.json({ ok: true }));
    app.get('/elections', authenticate, requireSociety, requireFeature('elections'), (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    const t = request(app);

    assert.equal((await t.get('/chat').set(s.one.h)).status, 200, 'enabled by override');
    const blocked = await t.get('/elections').set(s.one.h);
    assert.equal(blocked.status, 402);
    assert.equal(blocked.body.error.code, 'FEATURE_DISABLED');
    assert.equal((await t.get('/chat').set(s.two.h)).status, 402, 'free plan');
    assert.equal((await t.get('/elections').set(s.three.h)).status, 200, 'standard plan includes elections');
    assert.equal((await t.get('/chat').set(s.p)).status, 403, 'platform session has no society');
    assert.equal((await t.get('/chat')).status, 401);
  });
});

describe('portfolio', () => {
  test('aggregates only the societies the user manages', async () => {
    // A facility-management company employee: FM in Alpha, admin in Beta, plain resident in Gamma.
    await addMember(s.one, { name: 'Kiran Multi', email: 'multi@pp.test', role: 'facility_manager' });
    await api.post('/api/v1/users').set(s.two.h).send({ name: 'Kiran Multi', email: 'multi@pp.test', role: 'admin' });
    await api.post('/api/v1/users').set(s.three.h).send({ name: 'Kiran Multi', email: 'multi@pp.test', role: 'resident', unit: s.three.units[0]._id, residentType: 'owner' });
    const multi = await login('multi@pp.test');

    await api.post('/api/v1/bills/generate').set(s.one.h).send({ period: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7) });
    await api.post('/api/v1/complaints').set(bearer(s.ravi.accessToken)).send({ category: 'plumbing', title: 'Kitchen tap leaking badly' });
    await api.post('/api/v1/sos').set(bearer(s.ravi.accessToken)).send({ type: 'medical' });

    const res = await api.get('/api/v1/portfolio').set(bearer(multi.accessToken));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const names = res.body.data.societies.map((r) => r.society.name).sort();
    assert.deepEqual(names, ['Alpha Towers', 'Beta Residency'], 'resident membership in Gamma is not a manager role');
    const alpha = res.body.data.societies.find((r) => r.society.name === 'Alpha Towers');
    assert.equal(alpha.billedThisMonth, 3 * 100000);
    assert.equal(alpha.collectedThisMonth, 0);
    assert.equal(alpha.openComplaints, 1);
    assert.equal(alpha.activeSos, 1);
    assert.equal(alpha.role, 'facility_manager');
    assert.ok(alpha.membershipId);
    assert.equal(res.body.data.totals.societies, 2);
    assert.equal(res.body.data.totals.units, 6);
    assert.equal(res.body.data.totals.activeSos, 1);

    const single = await api.get('/api/v1/portfolio').set(s.three.h);
    assert.equal(single.body.data.societies.length, 1);
    const resident = await api.get('/api/v1/portfolio').set(bearer(s.ravi.accessToken));
    assert.equal(resident.body.data.societies.length, 0, 'residents manage nothing');
  });
});

describe('reports & exports', () => {
  test('catalogue depends on role', async () => {
    const admin = await api.get('/api/v1/reports').set(s.one.h);
    assert.equal(admin.body.data.length, 10);
    const acc = (await api.get('/api/v1/reports').set(bearer(s.accSession.accessToken))).body.data.map((r) => r.key);
    assert.deepEqual(acc.sort(), ['bills', 'defaulters', 'payments']);
    const fm = (await api.get('/api/v1/reports').set(bearer(s.fmSession.accessToken))).body.data.map((r) => r.key);
    assert.ok(fm.includes('visitors') && !fm.includes('bills') && !fm.includes('audit'));
    const resident = await api.get('/api/v1/reports').set(bearer(s.ravi.accessToken));
    assert.equal(resident.status, 403);
  });

  test('exports stream with the right content type and stay inside the tenant', async () => {
    const csv = await api.get('/api/v1/reports/members/export?format=csv').set(s.one.h);
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.headers['content-disposition'], /attachment; filename=".+-members-.+\.csv"/);
    assert.match(csv.text, /admin1@pp\.test/);
    assert.ok(!csv.text.includes('admin2@pp.test'), 'no rows from another society');
    assert.ok(csv.text.startsWith('﻿Name,Email'));

    const xlsx = await api.get('/api/v1/reports/units/export?format=xlsx').set(s.one.h).buffer(true).parse(binary);
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers['content-type'], /spreadsheetml/);
    assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK', 'xlsx is a zip');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    assert.equal(wb.worksheets[0].rowCount, 4, 'header + 3 units');

    const pdf = await api.get('/api/v1/reports/bills/export?format=pdf').set(bearer(s.accSession.accessToken)).buffer(true).parse(binary);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers['content-type'], /application\/pdf/);
    assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');

    const bills = await api.get('/api/v1/reports/bills/export?format=csv').set(bearer(s.accSession.accessToken));
    assert.equal(bills.text.trim().split('\r\n').length, 4, 'header + 3 bills of this society');
    assert.match(bills.text, /1000\.00/, 'money exported in rupees');

    const complaints = await api.get('/api/v1/reports/complaints/export').set(bearer(s.fmSession.accessToken));
    assert.match(complaints.text, /Kitchen tap leaking badly/);
    assert.match(complaints.text, /Open|Met|Breached/);

    const accVisitors = await api.get('/api/v1/reports/visitors/export').set(bearer(s.accSession.accessToken));
    assert.equal(accVisitors.status, 403, 'accountant gets financial reports only');
    const residentExport = await api.get('/api/v1/reports/members/export').set(bearer(s.ravi.accessToken));
    assert.equal(residentExport.status, 403);
    const badFormat = await api.get('/api/v1/reports/members/export?format=doc').set(s.one.h);
    assert.equal(badFormat.status, 422);
    const badRange = await api.get('/api/v1/reports/visitors/export?from=2026-10-10&to=2026-10-01').set(s.one.h);
    assert.equal(badRange.status, 400);
    const audit = await api.get('/api/v1/reports/audit/export').set(s.one.h);
    assert.match(audit.text, /report\.exported/, 'exports are audited');
  });

  test('CSV cells that look like formulas are neutralised', async () => {
    await addMember(s.one, { name: '=HYPERLINK("x")', email: 'evil@pp.test', role: 'guard' });
    const csv = await api.get('/api/v1/reports/members/export').set(s.one.h);
    assert.match(csv.text, /"'=HYPERLINK\(""x""\)"/);
  });

  test('scheduled summary emails', async () => {
    const fm = await api.post('/api/v1/reports/schedules').set(bearer(s.fmSession.accessToken)).send({ frequency: 'weekly' });
    assert.equal(fm.status, 403);
    const created = await api.post('/api/v1/reports/schedules').set(s.one.h).send({ frequency: 'weekly' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const next = new Date(created.body.data.nextRunAt);
    assert.equal(new Date(next.getTime() + 5.5 * 3600000).getUTCDay(), 1, 'Monday');
    assert.equal(next.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' }), '08:00:00');
    const dup = await api.post('/api/v1/reports/schedules').set(s.one.h).send({ frequency: 'weekly' });
    assert.equal(dup.status, 409);

    const sent = await api.post(`/api/v1/reports/schedules/${created.body.data._id}/send`).set(s.one.h);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(sent.body.data.sentTo, ['admin1@pp.test']);
    assert.equal(sent.body.data.summary.complaints.open, 1);

    const run = await jobs.reports.runScheduled(new Date(next.getTime() + 60000));
    assert.equal(run.sent, 1);
    const list = await api.get('/api/v1/reports/schedules').set(s.one.h);
    assert.ok(new Date(list.body.data[0].nextRunAt) > next, 'moved to the following week');

    const preview = await api.get('/api/v1/reports/schedules/preview?frequency=monthly').set(s.one.h);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.data.lines.length, 4);
    const otherSoc = await api.patch(`/api/v1/reports/schedules/${created.body.data._id}`).set(s.two.h).send({ enabled: false });
    assert.equal(otherSoc.status, 404);
  });
});

describe('builder handover', () => {
  test('module is gated by the builder feature', async () => {
    const off = await api.get('/api/v1/builder/progress').set(s.three.h);
    assert.equal(off.status, 402);
    const on = await api.get('/api/v1/builder/progress').set(s.one.h);
    assert.equal(on.status, 200, 'enabled for Alpha by override');
  });

  test('possession scheduling with slot clash and checklist', async () => {
    await addMember(s.one, { name: 'Dev Builder', email: 'builder@pp.test', role: 'admin', designation: 'Builder' });
    s.builder = await login('builder@pp.test');
    const b = bearer(s.builder.accessToken);
    const first = await api.post('/api/v1/builder/possessions').set(b).send({ unit: s.one.units[0]._id, buyerName: 'Ravi', buyerEmail: 'ravi@pp.test', date: '2026-11-02', startTime: '10:00', endTime: '11:00' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.checklist.length, 6);
    const clash = await api.post('/api/v1/builder/possessions').set(b).send({ unit: s.one.units[1]._id, buyerName: 'Neha', date: '2026-11-02', startTime: '10:30', endTime: '11:30' });
    assert.equal(clash.status, 409);
    const fine = await api.post('/api/v1/builder/possessions').set(b).send({ unit: s.one.units[1]._id, buyerName: 'Neha', date: '2026-11-02', startTime: '11:00', endTime: '12:00' });
    assert.equal(fine.status, 201);

    const early = await api.post(`/api/v1/builder/possessions/${first.body.data._id}/complete`).set(b).send({});
    assert.equal(early.status, 409, 'checklist must be finished');
    const ticked = await api.patch(`/api/v1/builder/possessions/${first.body.data._id}`).set(b).send({ checklist: first.body.data.checklist.map((c) => ({ _id: c._id, done: true })) });
    assert.equal(ticked.status, 200);
    const done = await api.post(`/api/v1/builder/possessions/${first.body.data._id}/complete`).set(b).send({ note: 'Keys handed over' });
    assert.equal(done.body.data.status, 'completed');

    const mine = await api.get('/api/v1/builder/possessions').set(bearer(s.ravi.accessToken));
    assert.equal(mine.body.data.length, 1, 'buyer sees only their unit');
    const residentCreate = await api.post('/api/v1/builder/possessions').set(bearer(s.ravi.accessToken)).send({ unit: s.one.units[0]._id, buyerName: 'x', date: '2026-11-03', startTime: '10:00', endTime: '11:00' });
    assert.equal(residentCreate.status, 403);
  });

  test('snag workflow: raise, fix, reopen, buyer sign-off', async () => {
    const b = bearer(s.builder.accessToken);
    const ravi = bearer(s.ravi.accessToken);
    const snag = await api.post('/api/v1/builder/snags').set(b).send({ unit: s.one.units[0]._id, title: 'Cracked tile in master bathroom', category: 'flooring', location: 'Master bathroom', contractor: { name: 'Shree Tiles', phone: '9811111111' } });
    assert.equal(snag.status, 201, JSON.stringify(snag.body));
    assert.match(snag.body.data.number, /^SNG-/);
    const byBuyer = await api.post('/api/v1/builder/snags').set(ravi).send({ unit: s.one.units[2]._id, title: 'Balcony door does not lock', category: 'windows_doors' });
    assert.equal(byBuyer.status, 201);
    assert.equal(byBuyer.body.data.unit.label, s.one.units[0].label, 'buyers can only raise for their own unit');

    const neha = await api.get('/api/v1/builder/snags').set(bearer(s.neha.accessToken));
    assert.equal(neha.body.data.length, 0, 'other buyers do not see it');
    const raviList = await api.get('/api/v1/builder/snags').set(ravi);
    assert.equal(raviList.body.data.length, 2);

    const id = snag.body.data._id;
    assert.equal((await api.post(`/api/v1/builder/snags/${id}/sign-off`).set(ravi).send({})).status, 409, 'cannot sign off an open snag');
    assert.equal((await api.patch(`/api/v1/builder/snags/${id}`).set(ravi).send({ status: 'fixed' })).status, 403);
    await api.patch(`/api/v1/builder/snags/${id}`).set(b).send({ status: 'in_progress' });
    const fixed = await api.patch(`/api/v1/builder/snags/${id}`).set(b).send({ status: 'fixed', note: 'Tile replaced' });
    assert.equal(fixed.body.data.status, 'fixed');
    const reopened = await api.post(`/api/v1/builder/snags/${id}/reopen`).set(ravi).send({ note: 'Grout still missing' });
    assert.equal(reopened.body.data.status, 'reopened');
    await api.patch(`/api/v1/builder/snags/${id}`).set(b).send({ status: 'fixed' });
    const signed = await api.post(`/api/v1/builder/snags/${id}/sign-off`).set(ravi).send({ note: 'Looks good' });
    assert.equal(signed.body.data.status, 'verified');
    assert.equal(signed.body.data.signOff.name, 'Ravi');
    assert.equal(signed.body.data.history.map((h) => h.to).join('>'), 'open>in_progress>fixed>reopened>fixed>verified');
    const backwards = await api.patch(`/api/v1/builder/snags/${id}`).set(b).send({ status: 'in_progress' });
    assert.equal(backwards.status, 409);

    const summary = await api.get('/api/v1/builder/snags/summary').set(b);
    const row = summary.body.data.find((r) => r.unit.label === s.one.units[0].label);
    assert.deepEqual([row.total, row.open, row.verified], [2, 1, 1]);
  });

  test('progress updates are visible to buyers', async () => {
    const post = await api.post('/api/v1/builder/progress').set(bearer(s.builder.accessToken)).send({ title: 'Tower A terrace waterproofing done', milestone: 'Terrace', percentComplete: 92, tower: 'A' });
    assert.equal(post.status, 201);
    const seen = await api.get('/api/v1/builder/progress').set(bearer(s.ravi.accessToken));
    assert.equal(seen.body.data[0].percentComplete, 92);
    const del = await api.delete(`/api/v1/builder/progress/${post.body.data._id}`).set(bearer(s.ravi.accessToken));
    assert.equal(del.status, 403);
  });

  test('handover checklist needs both signatures and produces a PDF', async () => {
    const b = bearer(s.builder.accessToken);
    const h = await api.get('/api/v1/builder/handover').set(b);
    assert.ok(h.body.data.items.length >= 10);
    assert.equal((await api.post('/api/v1/builder/handover/sign').set(b).send({ side: 'builder' })).status, 409, 'pending items block signing');

    for (const item of h.body.data.items) {
      // eslint-disable-next-line no-await-in-loop
      await api.patch(`/api/v1/builder/handover/items/${item._id}`).set(b).send({ status: item.category === 'funds' ? 'transferred' : 'not_applicable', reference: 'REF-1' });
    }
    const corpus = h.body.data.items.find((i) => i.title === 'Corpus fund');
    const withAmount = await api.patch(`/api/v1/builder/handover/items/${corpus._id}`).set(b).send({ amount: 5000000, status: 'transferred' });
    assert.equal(withAmount.body.data.progress.transferred, 3);

    assert.equal((await api.post('/api/v1/builder/handover/sign').set(b).send({ side: 'association' })).status, 403, 'builder cannot sign for the association');
    assert.equal((await api.post('/api/v1/builder/handover/sign').set(s.one.h).send({ side: 'builder' })).status, 403, 'association admin cannot sign for the builder');
    const bSigned = await api.post('/api/v1/builder/handover/sign').set(b).send({ side: 'builder', note: 'All handed over' });
    assert.equal(bSigned.body.data.status, 'awaiting_signatures');
    const aSigned = await api.post('/api/v1/builder/handover/sign').set(s.one.h).send({ side: 'association', name: 'Alpha Secretary' });
    assert.equal(aSigned.status, 200, JSON.stringify(aSigned.body));
    assert.equal(aSigned.body.data.status, 'completed');

    const locked = await api.post('/api/v1/builder/handover/items').set(b).send({ category: 'other', title: 'Late item' });
    assert.equal(locked.status, 409);
    const pdf = await api.get('/api/v1/builder/handover/pdf').set(s.one.h).buffer(true).parse(binary);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  });
});

describe('insights (heuristics)', () => {
  test('complaint category suggestions are ranked with confidence', async () => {
    const r = bearer(s.ravi.accessToken);
    for (const [category, title] of [
      ['plumbing', 'Bathroom tap leaking'],
      ['plumbing', 'Drain blocked in kitchen'],
      ['electrical', 'Fan not working, switch sparking'],
      ['lift', 'Lift door not closing on 3rd floor'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await api.post('/api/v1/complaints').set(r).send({ category, title });
    }
    const { clearModel } = await import('../src/modules/insights/complaintCategories.js');
    clearModel(s.one.id);

    const res = await api.post('/api/v1/insights/complaint-category').set(r).send({ title: 'Water leaking from the bathroom tap', description: 'pipe below the basin' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [top, ...rest] = res.body.data.suggestions;
    assert.equal(top.category, 'plumbing');
    assert.ok(top.confidence > 0.5 && top.confidence <= 1);
    assert.ok(rest.every((x) => x.score <= top.score), 'sorted by score');
    assert.ok(top.matched.includes('tap'));
    assert.equal(res.body.data.method, 'heuristic');

    const lift = await api.post('/api/v1/insights/complaint-category').set(r).send({ title: 'Lift stuck between floors' });
    assert.equal(lift.body.data.suggestions[0].category, 'lift');
    assert.equal(lift.body.data.suggestedPriority, 'urgent');
    const vague = await api.post('/api/v1/insights/complaint-category').set(r).send({ title: 'Need help please' });
    assert.equal(vague.body.data.suggestions[0].category, 'other');
  });

  test('defaulter risk explains its factors', async () => {
    const now = Date.now();
    const bills = await models.Bill.find({ society: s.one.id }).sort({ billNumber: 1 }).lean();
    assert.equal(bills.length, 3);
    // unit 0: overdue 40 days and unpaid; unit 1: paid 20 days late; unit 2: paid on time
    await models.Bill.updateMany({ society: s.one.id }, { dueDate: new Date(now - 40 * DAY) });
    await models.Payment.create({ society: s.one.id, bill: bills[1]._id, unit: bills[1].unit, amount: bills[1].total, method: 'cash', status: 'success', paidAt: new Date(now - 20 * DAY) });
    await models.Bill.updateOne({ _id: bills[1]._id }, { paid: bills[1].total, status: 'paid' });
    await models.Payment.create({ society: s.one.id, bill: bills[2]._id, unit: bills[2].unit, amount: bills[2].total, method: 'cash', status: 'success', paidAt: new Date(now - 45 * DAY) });
    await models.Bill.updateOne({ _id: bills[2]._id }, { paid: bills[2].total, status: 'paid' });

    const res = await api.get('/api/v1/insights/defaulter-risk').set(bearer(s.accSession.accessToken));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [worst, middle, best] = res.body.data.items;
    assert.equal(String(worst.unit._id), String(bills[0].unit));
    assert.ok(worst.score > middle.score && middle.score > best.score);
    assert.equal(best.score, 0);
    assert.equal(worst.overdueBills, 1);
    assert.equal(worst.factors.length, 4);
    assert.ok(worst.factors.every((f) => f.explanation && f.points <= f.max));
    assert.equal(res.body.data.method, 'heuristic');

    const detail = await api.get(`/api/v1/insights/defaulter-risk/${bills[1].unit}`).set(s.one.h);
    assert.equal(detail.body.data.bills[0].daysLate, 20);
    const fm = await api.get('/api/v1/insights/defaulter-risk').set(bearer(s.fmSession.accessToken));
    assert.equal(fm.status, 403);
    const otherSoc = await api.get(`/api/v1/insights/defaulter-risk/${bills[1].unit}`).set(s.two.h);
    assert.equal(otherSoc.status, 404);
  });

  test('notice templates fill in the blanks', async () => {
    const list = await api.get('/api/v1/insights/notice-templates').set(bearer(s.fmSession.accessToken));
    assert.deepEqual(list.body.data.map((t) => t.key), ['water_cut', 'maintenance_due', 'agm', 'festival']);
    const partial = await api.post('/api/v1/insights/notice-templates/water_cut').set(s.one.h).send({ values: { from: '10:00' } });
    assert.deepEqual(partial.body.data.missing, ['date', 'to']);
    assert.match(partial.body.data.body, /\[Date\]/);
    const full = await api.post('/api/v1/insights/notice-templates/water_cut').set(s.one.h).send({ values: { date: '2026-10-17', from: '10:00', to: '14:00' } });
    assert.match(full.body.data.title, /Saturday, 17 October 2026/);
    assert.match(full.body.data.body, /10:00 AM to 2:00 PM/);
    assert.match(full.body.data.body, /Alpha Towers/);
    const none = await api.post('/api/v1/insights/notice-templates/unknown').set(s.one.h).send({});
    assert.equal(none.status, 404);
    const resident = await api.get('/api/v1/insights/notice-templates').set(bearer(s.ravi.accessToken));
    assert.equal(resident.status, 403);
  });

  test('monthly society health summary', async () => {
    const res = await api.get('/api/v1/insights/health').set(s.one.h);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.score >= 0 && res.body.data.score <= 100);
    assert.match(res.body.data.grade, /^[ABCD]$/);
    assert.equal(res.body.data.metrics.units, 3);
    assert.ok(res.body.data.metrics.complaints.opened >= 5);
    assert.ok(Array.isArray(res.body.data.highlights));
    const acc = await api.get('/api/v1/insights/health').set(bearer(s.accSession.accessToken));
    assert.equal(acc.status, 403, 'admins only');
  });
});
