import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bearer, setup, teardown } from './helpers.js';

let api;
let providers;
let models;
const s = {};
const PASSWORD = 'Password@123';
const A_KEY = 'rzp_test_societyAlpha01';
const A_SECRET = 'secret_alpha_0123456789';
const A_WEBHOOK = 'whsec_alpha_hook_9876';
const B_KEY = 'rzp_test_societyBeta02';
const B_SECRET = 'secret_beta_abcdefghij';

const IST = (d = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const plusDays = (n) => IST(Date.now() + n * 86400000);
const fp = (secret) => crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
const lastCall = (op) => [...providers.mockCalls].reverse().find((c) => c.op === op);

const login = async (identifier) => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password: PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return bearer(res.body.data.accessToken);
};

async function newSociety(name, prefix) {
  const reg = await api.post('/api/v1/auth/register-society').send({ society: { name }, admin: { name: `${name} Admin`, email: `admin@${prefix}.test`, password: PASSWORD } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const h = bearer(reg.body.data.accessToken);
  const block = await api.post('/api/v1/blocks').set(h).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 3, areaSqft: 1000 });
  const units = (await api.get('/api/v1/units').set(h)).body.data;
  await api.patch('/api/v1/society/me/settings').set(h).send({ billing: { fixedAmount: 150000 } });
  const soc = { h, id: reg.body.data.user.society._id, units };
  for (const [key, role, unit] of [['r1', 'resident', 0], ['r2', 'resident', 1], ['acc', 'accountant']]) {
    const body = { name: `${prefix} ${key}`, email: `${key}@${prefix}.test`, password: PASSWORD, role };
    if (unit !== undefined) Object.assign(body, { unit: units[unit]._id, residentType: 'owner' });
    // eslint-disable-next-line no-await-in-loop
    const res = await api.post('/api/v1/users').set(h).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // eslint-disable-next-line no-await-in-loop
    soc[key] = await login(body.email);
  }
  return soc;
}

async function billFor(soc, unitIndex, period) {
  const gen = await api.post('/api/v1/bills/generate').set(soc.h).send({ period, units: [soc.units[unitIndex]._id], dueDate: plusDays(20) });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  return models.Bill.findOne({ society: soc.id, unit: soc.units[unitIndex]._id, period }).lean();
}

async function platformMember(email, roleKey) {
  const { ensureSystemRoles } = await import('../src/modules/platformTeam/access.js');
  const role = (await ensureSystemRoles()).find((r) => r.key === roleKey);
  await models.User.create({ name: roleKey, email, passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'staff', platformRoleId: role._id, platformStatus: 'active' });
  return login(email);
}

before(async () => {
  api = await setup();
  providers = await import('../src/modules/payments/providers.js');
  models = {
    User: (await import('../src/modules/users/user.model.js')).default,
    Bill: (await import('../src/modules/billing/bill.model.js')).default,
    Payment: (await import('../src/modules/payments/payment.model.js')).default,
    PaymentSettings: (await import('../src/modules/paymentSettings/paymentSettings.model.js')).default,
    AmenityPayment: (await import('../src/modules/amenities/amenityPayment.model.js')).default,
  };
  s.a = await newSociety('Alpha Enclave', 'cpa');
  s.b = await newSociety('Beta Gardens', 'cpb');
  await models.User.create({ name: 'Owner', email: 'owner@cp.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'super_admin' });
  s.owner = await login('owner@cp.test');
  s.viewer = await platformMember('viewer@cp.test', 'viewer');
  s.billing = await platformMember('billing@cp.test', 'billing');
});
after(teardown);

describe('mode selection and activation', () => {
  test('a new society starts with online payments off; residents cannot pay online', async () => {
    const view = await api.get('/api/v1/payment-settings').set(s.a.h);
    assert.equal(view.status, 200);
    assert.equal(view.body.data.mode, 'disabled');
    assert.equal(view.body.data.status, 'off');
    const status = await api.get('/api/v1/payment-settings/status').set(s.a.r1);
    assert.equal(status.body.data.online, false);
    const bill = await billFor(s.a, 0, '2026-09');
    const order = await api.post('/api/v1/payments/orders').set(s.a.r1).send({ bill: bill._id });
    assert.equal(order.status, 400);
    assert.equal(order.body.error.code, 'ONLINE_PAYMENTS_OFF');
    s.a.bill = bill;
  });

  test('own gateway: keys are stored encrypted, the secret never comes back, only its last 4', async () => {
    assert.equal((await api.put('/api/v1/payment-settings/mode').set(s.a.h).send({ mode: 'platform_legacy' })).status, 422, 'legacy cannot be chosen');
    assert.equal((await api.put('/api/v1/payment-settings/mode').set(s.a.h).send({ mode: 'own' })).status, 200);
    assert.equal((await api.put('/api/v1/payment-settings/own').set(s.a.acc).send({ keyId: A_KEY, keySecret: A_SECRET })).status, 403, 'admin only');
    const saved = await api.put('/api/v1/payment-settings/own').set(s.a.h).send({ keyId: A_KEY, keySecret: A_SECRET, webhookSecret: A_WEBHOOK });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const raw = JSON.stringify(saved.body);
    assert.ok(!raw.includes(A_SECRET) && !raw.includes(A_WEBHOOK), 'secrets are never returned');
    assert.equal(saved.body.data.own.keySecretLast4, A_SECRET.slice(-4));
    assert.equal(saved.body.data.own.webhookSecretLast4, A_WEBHOOK.slice(-4));
    assert.equal(saved.body.data.status, 'off');
    const stored = await models.PaymentSettings.findOne({ society: s.a.id }).select('+own.keySecret +own.webhookSecret').lean();
    assert.match(stored.own.keySecret, /^v1\./);
    assert.notEqual(stored.own.keySecret, A_SECRET);
    assert.ok(!JSON.stringify(stored).includes(A_SECRET));
    const accView = await api.get('/api/v1/payment-settings').set(s.a.acc);
    assert.equal(accView.status, 200);
    assert.ok(!JSON.stringify(accView.body).includes('v1.'), 'sealed value is not returned either');
    assert.equal((await api.get('/api/v1/payment-settings').set(s.a.r1)).status, 403);
  });

  test('switching on needs a passing connection test; wrong keys fail', async () => {
    const early = await api.post('/api/v1/payment-settings/enable').set(s.a.h);
    assert.equal(early.status, 400);
    assert.match(early.body.error.message, /Test the connection/);
    await api.put('/api/v1/payment-settings/own').set(s.a.h).send({ keyId: 'rzp_test_wrong_bad', keySecret: 'not-the-secret' });
    const bad = await api.post('/api/v1/payment-settings/own/test').set(s.a.h);
    assert.equal(bad.body.data.own.connection.ok, false);
    assert.equal(lastCall('testConnection').keyId, 'rzp_test_wrong_bad');
    assert.equal((await api.put('/api/v1/payment-settings/own').set(s.a.h).send({ keyId: A_KEY })).status, 400, 'a new key id needs its secret');
    await api.put('/api/v1/payment-settings/own').set(s.a.h).send({ keyId: A_KEY, keySecret: A_SECRET });
    const good = await api.post('/api/v1/payment-settings/own/test').set(s.a.h);
    assert.equal(good.body.data.own.connection.ok, true);
    const call = lastCall('testConnection');
    assert.equal(call.keyId, A_KEY);
    assert.equal(call.secret, fp(A_SECRET), 'the adapter got the society’s own secret');

    const test1 = await api.post('/api/v1/payment-settings/test-payment').set(s.a.h);
    assert.equal(test1.status, 200, JSON.stringify(test1.body));
    assert.equal(test1.body.data.instant, true);
    assert.equal(test1.body.data.settings.testPayment.ok, true);
    assert.equal(test1.body.data.settings.testPayment.amount, 100);
    assert.equal(lastCall('createOrder').keyId, A_KEY);

    const on = await api.post('/api/v1/payment-settings/enable').set(s.a.h);
    assert.equal(on.status, 200);
    assert.equal(on.body.data.status, 'active');
    assert.ok(on.body.data.activatedAt);
    assert.equal((await api.get('/api/v1/payment-settings/status').set(s.a.r1)).body.data.online, true);
  });
});

describe('every resident payment uses the society’s gateway', () => {
  test('bill orders and verify go through the society’s own keys', async () => {
    const order = await api.post('/api/v1/payments/orders').set(s.a.r1).send({ bill: s.a.bill._id });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal(order.body.data.keyId, A_KEY, 'checkout opens on the society’s Razorpay account');
    const call = lastCall('createOrder');
    assert.equal(call.keyId, A_KEY);
    assert.equal(call.secret, fp(A_SECRET));
    // A signature from the platform's account does not verify on the society's account.
    const paymentId = 'mock_pay_platform1';
    const platformSig = providers.mockProvider.sign(order.body.data.orderId, paymentId);
    assert.equal((await api.post('/api/v1/payments/verify').set(s.a.r1).send({ orderId: order.body.data.orderId, paymentId, signature: platformSig })).status, 400);
    const order2 = await api.post('/api/v1/payments/orders').set(s.a.r1).send({ bill: s.a.bill._id });
    const signed = (await api.post('/api/v1/payments/mock/sign').set(s.a.r1).send({ orderId: order2.body.data.orderId })).body.data;
    const paid = await api.post('/api/v1/payments/verify').set(s.a.r1).send(signed);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.status, 'success');
    const advance = await api.post('/api/v1/payments/orders').set(s.a.r2).send({ advance: 50000 });
    assert.equal(advance.body.data.keyId, A_KEY);
  });

  test('amenity payments and their refunds use the society’s keys', async () => {
    const hall = await api.post('/api/v1/amenities').set(s.a.h).send({
      name: 'Party hall', capacity: 1, openTime: '09:00', closeTime: '21:00', slotMinutes: 120, fee: 100000,
      maxBookingsPerUnitPerDay: 5, paymentMode: 'online', cancellation: { fullRefundHours: 24, partialRefundHours: 6, partialRefundPercent: 50 },
    });
    assert.equal(hall.status, 201, JSON.stringify(hall.body));
    const b = await api.post('/api/v1/bookings').set(s.a.r1).send({ amenity: hall.body.data._id, date: plusDays(4), startTime: '09:00', endTime: '11:00' });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const order = await api.post(`/api/v1/bookings/${b.body.data._id}/pay`).set(s.a.r1);
    assert.equal(order.status, 200, JSON.stringify(order.body));
    assert.equal(order.body.data.keyId, A_KEY);
    assert.equal(lastCall('createOrder').secret, fp(A_SECRET));
    const signed = (await api.post('/api/v1/payments/mock/sign').set(s.a.r1).send({ orderId: order.body.data.orderId })).body.data;
    const ok = await api.post('/api/v1/amenities/payments/verify').set(s.a.r1).send(signed);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.booking.status, 'confirmed');
    const cancel = await api.post(`/api/v1/bookings/${b.body.data._id}/cancel`).set(s.a.r1).send({});
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    const refund = lastCall('refund');
    assert.equal(refund.keyId, A_KEY, 'refund goes back through the account that took the money');
    assert.equal(refund.secret, fp(A_SECRET));
    assert.equal(refund.amount, 100000);
  });

  test('event tickets use the society’s keys', async () => {
    const at = (h) => new Date(Date.now() + h * 3600000).toISOString();
    const ev = await api.post('/api/v1/events').set(s.a.h).send({ title: 'Diwali night', startAt: at(48), endAt: at(51), ticketPrice: 30000, capacity: 20 });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    await api.post(`/api/v1/events/${ev.body.data._id}/rsvp`).set(s.a.r2).send({ response: 'yes', guests: 0, paymentMode: 'online' });
    const order = await api.post(`/api/v1/events/${ev.body.data._id}/pay`).set(s.a.r2);
    assert.equal(order.status, 200, JSON.stringify(order.body));
    assert.equal(order.body.data.keyId, A_KEY);
    const signed = (await api.post('/api/v1/events/payments/mock/sign').set(s.a.r2).send({ orderId: order.body.data.orderId })).body.data;
    const paid = await api.post('/api/v1/events/payments/verify').set(s.a.r2).send(signed);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.rsvp.paymentStatus, 'paid');
  });

  test('autopay mandates and charges use the society’s keys', async () => {
    await api.patch('/api/v1/finance/settings').set(s.a.h).send({ autopayEnabled: true });
    const optIn = await api.post('/api/v1/payments/autopay').set(s.a.r2).send({ maxAmount: 500000, method: 'upi' });
    assert.equal(optIn.status, 200, JSON.stringify(optIn.body));
    assert.equal(lastCall('registerMandate').keyId, A_KEY);
    const bill = await billFor(s.a, 1, '2026-10');
    const charge = lastCall('chargeRecurring');
    assert.equal(charge.keyId, A_KEY);
    assert.equal(charge.secret, fp(A_SECRET));
    assert.equal((await models.Bill.findById(bill._id).lean()).status, 'paid');
  });
});

describe('per-society webhook', () => {
  const deliver = (key, body, secret, eventId) => {
    const raw = JSON.stringify(body);
    return api
      .post(`/api/v1/payments/webhook/razorpay/${key}`)
      .set({ 'Content-Type': 'application/json', 'X-Razorpay-Signature': crypto.createHmac('sha256', secret).update(raw).digest('hex'), 'X-Razorpay-Event-Id': eventId })
      .send(raw);
  };
  const captured = (orderId) => ({ event: 'payment.captured', payload: { payment: { entity: { id: `pay_${crypto.randomBytes(4).toString('hex')}`, order_id: orderId, status: 'captured' } } } });

  test('is verified with the society’s own webhook secret and settles only its orders', async () => {
    const view = (await api.get('/api/v1/payment-settings').set(s.a.h)).body.data;
    const key = view.webhookUrl.split('/').pop();
    assert.match(view.webhookUrl, /\/api\/v1\/payments\/webhook\/razorpay\/[A-Za-z0-9_-]+$/);
    const bill = await billFor(s.a, 2, '2026-09');
    const r3 = await api.post('/api/v1/users').set(s.a.h).send({ name: 'cpa r3', email: 'r3@cpa.test', password: PASSWORD, role: 'resident', unit: s.a.units[2]._id, residentType: 'owner' });
    assert.equal(r3.status, 201);
    const r3h = await login('r3@cpa.test');
    const order = await api.post('/api/v1/payments/orders').set(r3h).send({ bill: bill._id });

    assert.equal((await deliver(key, captured(order.body.data.orderId), 'wrong-secret', 'e1')).status, 400);
    assert.equal((await deliver('unknownkey12345', captured(order.body.data.orderId), A_WEBHOOK, 'e2')).status, 404);
    const hook = await deliver(key, captured(order.body.data.orderId), A_WEBHOOK, 'e3');
    assert.equal(hook.status, 200, JSON.stringify(hook.body));
    assert.equal(hook.body.data.handled, 'bill');
    assert.equal((await models.Bill.findById(bill._id).lean()).status, 'paid');

    // Another society's order delivered to this society's webhook is not touched.
    await models.PaymentSettings.updateOne({ society: s.b.id }, { mode: 'platform_legacy', enabled: true });
    const bBill = await billFor(s.b, 0, '2026-09');
    const bOrder = await api.post('/api/v1/payments/orders').set(s.b.r1).send({ bill: bBill._id });
    const cross = await deliver(key, captured(bOrder.body.data.orderId), A_WEBHOOK, 'e4');
    assert.equal(cross.body.data.handled, 'unknown-order');
    assert.equal((await models.Bill.findById(bBill._id).lean()).status, 'unpaid');
    await models.PaymentSettings.updateOne({ society: s.b.id }, { mode: 'disabled', enabled: false });
  });
});

describe('Razorpay Route', () => {
  test('transfer payload keeps the platform commission and forwards the rest', () => {
    const [t] = providers.routeTransfers(100000, { account: 'acc_X1234', commissionPercent: 2.5 }, { receipt: 'BILL-1' });
    assert.equal(t.account, 'acc_X1234');
    assert.equal(t.amount, 97500);
    assert.equal(t.currency, 'INR');
    assert.equal(t.on_hold, 0);
    assert.equal(providers.routeTransfers(99999, { account: 'acc_X1234' })[0].amount, 99999, 'no commission by default');
  });

  test('platform links the account; once active, orders carry transfers on the platform account', async () => {
    assert.equal((await api.patch(`/api/v1/platform/payment-settings/${s.b.id}`).set(s.viewer).send({ route: { commissionPercent: 1 } })).status, 403, 'viewer is read-only');
    assert.equal((await api.get(`/api/v1/platform/payment-settings/${s.b.id}`).set(s.viewer)).status, 200);
    assert.equal((await api.patch(`/api/v1/platform/payment-settings/${s.b.id}`).set(s.b.h).send({ forceDisabled: true })).status, 403, 'society admins cannot use platform endpoints');

    assert.equal((await api.put('/api/v1/payment-settings/mode').set(s.b.h).send({ mode: 'route' })).status, 200);
    const link = await api.patch(`/api/v1/platform/payment-settings/${s.b.id}`).set(s.billing).send({
      route: { linkedAccountId: 'acc_betaRoute01', commissionPercent: 2, bank: { accountName: 'Beta Gardens Assn', accountLast4: '1234', ifsc: 'hdfc0001234', bankName: 'HDFC' } },
    });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.equal(link.body.data.route.status, 'pending');
    assert.equal(link.body.data.route.bank.ifsc, 'HDFC0001234');
    const early = await api.post('/api/v1/payment-settings/enable').set(s.b.h);
    assert.equal(early.status, 400);
    assert.match(early.body.error.message, /linked account is pending/);

    const refreshed = await api.post(`/api/v1/platform/payment-settings/${s.b.id}/route/refresh`).set(s.owner);
    assert.equal(refreshed.body.data.route.status, 'active');
    assert.equal(refreshed.body.data.route.kycStatus, 'verified');
    assert.equal((await api.post('/api/v1/payment-settings/enable').set(s.b.h)).status, 200);

    const bill = await billFor(s.b, 1, '2026-09');
    const order = await api.post('/api/v1/payments/orders').set(s.b.r2).send({ bill: bill._id });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.deepEqual(order.body.data.transfers.map((t) => [t.account, t.amount]), [['acc_betaRoute01', bill.total - Math.round(bill.total * 0.02)]]);
    const call = lastCall('createOrder');
    assert.equal(call.keyId, null, 'created on the platform account, not a society key');
    assert.equal(call.account, 'acc_betaRoute01');
    const signed = (await api.post('/api/v1/payments/mock/sign').set(s.b.r2).send({ orderId: order.body.data.orderId })).body.data;
    assert.equal((await api.post('/api/v1/payments/verify').set(s.b.r2).send(signed)).status, 200);
  });

  test('the platform decides the modes a society may use', async () => {
    const res = await api.patch(`/api/v1/platform/payment-settings/${s.b.id}`).set(s.owner).send({ allowedModes: ['own'] });
    assert.equal(res.body.data.status, 'blocked', 'route is no longer allowed');
    assert.equal((await api.put('/api/v1/payment-settings/mode').set(s.b.h).send({ mode: 'route' })).status, 403);
    await api.patch(`/api/v1/platform/payment-settings/${s.b.id}`).set(s.owner).send({ allowedModes: ['own', 'route'] });
    assert.equal((await api.get('/api/v1/payment-settings').set(s.b.h)).body.data.status, 'active');
  });
});

describe('platform force-disable', () => {
  test('stops every online payment until lifted; the society cannot switch it back on', async () => {
    const off = await api.patch(`/api/v1/platform/payment-settings/${s.a.id}`).set(s.billing).send({ forceDisabled: true, forceDisabledReason: 'KYC review' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.data.status, 'blocked');
    const bill = await billFor(s.a, 0, '2026-11');
    const order = await api.post('/api/v1/payments/orders').set(s.a.r1).send({ bill: bill._id });
    assert.equal(order.status, 400);
    assert.match(order.body.error.message, /KYC review/);
    assert.equal((await api.post('/api/v1/payment-settings/enable').set(s.a.h)).status, 403);
    assert.equal((await api.get('/api/v1/payment-settings').set(s.a.h)).body.data.forceDisabledReason, 'KYC review');
    await api.patch(`/api/v1/platform/payment-settings/${s.a.id}`).set(s.billing).send({ forceDisabled: false });
    assert.equal((await api.post('/api/v1/payments/orders').set(s.a.r1).send({ bill: bill._id })).status, 201);
  });

  test('payments.manage is in the Owner, Admin and Billing built-in roles', async () => {
    const { SYSTEM_ROLES } = await import('../src/modules/platformTeam/permissions.js');
    for (const key of ['owner', 'admin', 'billing']) assert.ok(SYSTEM_ROLES.find((r) => r.key === key).permissions.includes('payments.manage'), key);
    assert.ok(!SYSTEM_ROLES.find((r) => r.key === 'support').permissions.includes('payments.manage'));
  });
});

describe('existing societies', () => {
  test('a society without payment settings keeps the platform account (legacy) and can still pay', async () => {
    await models.PaymentSettings.deleteOne({ society: s.b.id });
    const view = await api.get('/api/v1/payment-settings').set(s.b.h);
    assert.equal(view.body.data.mode, 'platform_legacy');
    assert.equal(view.body.data.status, 'active');
    const bill = await billFor(s.b, 2, '2026-09');
    const r3 = await api.post('/api/v1/users').set(s.b.h).send({ name: 'cpb r3', email: 'r3@cpb.test', password: PASSWORD, role: 'resident', unit: s.b.units[2]._id, residentType: 'owner' });
    assert.equal(r3.status, 201);
    const r3h = await login('r3@cpb.test');
    const order = await api.post('/api/v1/payments/orders').set(r3h).send({ bill: bill._id });
    assert.equal(order.status, 201);
    assert.equal(order.body.data.keyId, undefined);
    assert.equal(lastCall('createOrder').account, null);
  });
});
