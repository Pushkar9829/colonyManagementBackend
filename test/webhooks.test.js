import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bearer, setup, teardown } from './helpers.js';

const { default: env } = await import('../src/config/env.js');
const { default: Mandate } = await import('../src/modules/payments/mandate.model.js');
const { default: Payment } = await import('../src/modules/payments/payment.model.js');

let api;
const s = { units: {} };
const PASSWORD = 'Password@123';
const SECRET = 'whsec_test_secret';
const as = (who) => bearer(s[who].accessToken);
const u = (label) => s.units[label];

// Sends a Razorpay-style webhook delivery signed with the test secret.
let seq = 0;
function webhook(body, { secret = SECRET, eventId = `evt_${(seq += 1)}` } = {}) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return api
    .post('/api/v1/payments/webhook/razorpay')
    .set({ 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': eventId })
    .send(raw);
}
const captured = (orderId, paymentId = `pay_${crypto.randomBytes(5).toString('hex')}`) => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: paymentId, order_id: orderId, status: 'captured' } } },
});
const sign = async (who, orderId) => (await api.post('/api/v1/payments/mock/sign').set(as(who)).send({ orderId })).body.data;

before(async () => {
  api = await setup();
  env.RAZORPAY_WEBHOOK_SECRET = SECRET;
  const reg = await api.post('/api/v1/auth/register-society').send({
    society: { name: 'Hook Society' },
    admin: { name: 'Hook Admin', email: 'admin@hook.test', password: PASSWORD },
  });
  s.admin = reg.body.data;
  const block = await api.post('/api/v1/blocks').set(as('admin')).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(as('admin')).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 2, areaSqft: 1000 });
  for (const unit of (await api.get('/api/v1/units').set(as('admin'))).body.data) s.units[unit.label] = unit._id;
  for (const [key, body] of [
    ['accountant', { name: 'Hook Accounts', email: 'acc@hook.test', role: 'accountant' }],
    ['r1', { name: 'Hook Resident', email: 'r1@hook.test', role: 'resident', unit: u('A-101'), residentType: 'owner' }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await api.post('/api/v1/users').set(as('admin')).send({ ...body, password: PASSWORD });
    // eslint-disable-next-line no-await-in-loop
    s[key] = (await api.post('/api/v1/auth/login').send({ identifier: body.email, password: PASSWORD })).body.data;
  }
  await api.patch('/api/v1/finance/settings').set(as('accountant')).send({ autopayEnabled: true });
  await api.patch('/api/v1/society/me/settings').set(as('admin')).send({ billing: { fixedAmount: 100000, perSqftRate: 0, chargeHeads: [] } });
});
after(async () => {
  env.RAZORPAY_WEBHOOK_SECRET = '';
  await teardown();
});

describe('webhook endpoint', () => {
  test('rejects bad signatures and is off without a secret', async () => {
    const bad = await webhook(captured('order_x'), { secret: 'wrong' });
    assert.equal(bad.status, 400);
    env.RAZORPAY_WEBHOOK_SECRET = '';
    assert.equal((await webhook(captured('order_x'))).status, 404);
    env.RAZORPAY_WEBHOOK_SECRET = SECRET;
    const unknown = await webhook(captured('order_unknown'));
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.data.handled, 'unknown-order');
  });
});

describe('autopay mandate sign-up', () => {
  test('start, authorise in checkout, confirm: the mandate turns on and ₹1 becomes advance', async () => {
    const start = await api.post('/api/v1/payments/autopay/start').set(as('r1')).send({ maxAmount: 500000, method: 'upi' });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    assert.equal(start.body.data.amount, 100);
    assert.ok(start.body.data.customerId);
    assert.equal((await api.get('/api/v1/payments/autopay').set(as('r1'))).body.data.mandate, null, 'not on until authorised');

    const signed = await sign('r1', start.body.data.orderId);
    const conf = await api.post('/api/v1/payments/autopay/confirm').set(as('r1')).send(signed);
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
    assert.equal(conf.body.data.status, 'active');
    assert.equal(conf.body.data.tokenId, undefined, 'token is never returned');

    // retry of the same confirm is harmless
    assert.equal((await api.post('/api/v1/payments/autopay/confirm').set(as('r1')).send(signed)).body.data.status, 'active');
    const auth = await Payment.find({ providerOrderId: start.body.data.orderId }).lean();
    assert.equal(auth.length, 1);
    assert.equal(auth[0].status, 'success');
    assert.equal(auth[0].advanceAmount, 100);

    // a limit above what the bank authorised needs a new mandate
    const raise = await api.post('/api/v1/payments/autopay').set(as('r1')).send({ maxAmount: 900000 });
    assert.equal(raise.status, 400);
    assert.equal((await api.post('/api/v1/payments/autopay').set(as('r1')).send({ maxAmount: 300000 })).status, 200);
  });

  test('a forged checkout signature is refused', async () => {
    const start = await api.post('/api/v1/payments/autopay/start').set(as('r1')).send({ maxAmount: 500000 });
    const res = await api.post('/api/v1/payments/autopay/confirm').set(as('r1')).send({ orderId: start.body.data.orderId, paymentId: 'mock_pay_forged', signature: 'f'.repeat(64) });
    assert.equal(res.status, 400);
  });

  test('webhook finishes a sign-up whose browser closed; the new mandate replaces the old', async () => {
    const before = await Mandate.findOne({ unit: u('A-101'), status: 'active' }).lean();
    const start = await api.post('/api/v1/payments/autopay/start').set(as('r1')).send({ maxAmount: 800000, method: 'upi' });
    const hook = await webhook(captured(start.body.data.orderId));
    assert.equal(hook.status, 200, JSON.stringify(hook.body));
    assert.equal(hook.body.data.handled, 'mandate');
    const mine = (await api.get('/api/v1/payments/autopay').set(as('r1'))).body.data;
    assert.equal(mine.mandate.maxAmount, 800000);
    assert.equal((await Mandate.findById(before._id).lean()).status, 'cancelled');
  });

  test('token.cancelled from the bank switches autopay off', async () => {
    const m = await Mandate.findOne({ unit: u('A-101'), status: 'active' }).lean();
    const res = await webhook({ event: 'token.cancelled', payload: { token: { entity: { id: m.tokenId } } } });
    assert.equal(res.body.data.handled, 'mandate');
    assert.equal((await Mandate.findById(m._id).lean()).status, 'cancelled');
    const notes = (await api.get('/api/v1/notifications').set(as('r1'))).body.data;
    assert.ok(notes.some((n) => /switched off/.test(n.title)));
  });
});

describe('online bill payment confirmed by webhook', () => {
  test('paid but the app closed: the webhook settles the bill once, a late verify is idempotent', async () => {
    const gen = await api.post('/api/v1/bills/generate').set(as('accountant')).send({ period: '2026-11', units: [u('A-101')], dueDate: '2026-12-31' });
    assert.equal(gen.status, 201, JSON.stringify(gen.body));
    const bill = (await api.get(`/api/v1/bills?unit=${u('A-101')}&period=2026-11`).set(as('accountant'))).body.data[0];
    const order = (await api.post('/api/v1/payments/orders').set(as('r1')).send({ bill: bill._id })).body.data;

    const delivery = captured(order.orderId);
    const hook = await webhook(delivery, { eventId: 'evt_bill_1' });
    assert.equal(hook.body.data.handled, 'bill');
    assert.equal((await api.get(`/api/v1/bills/${bill._id}`).set(as('accountant'))).body.data.status, 'paid');

    // Razorpay redelivers the same event
    assert.equal((await webhook(delivery, { eventId: 'evt_bill_1' })).body.data.handled, 'duplicate');

    const lateSig = await sign('r1', order.orderId);
    const late = await api.post('/api/v1/payments/verify').set(as('r1')).send(lateSig);
    assert.equal(late.status, 200);
    assert.equal(late.body.data.status, 'success');
    const paid = await Payment.find({ bill: bill._id, status: 'success' }).lean();
    assert.equal(paid.length, 1);
    assert.equal(paid[0].advanceAmount, 0);
  });

  test('checkout verify racing the webhook applies the money once', async () => {
    const gen = await api.post('/api/v1/bills/generate').set(as('accountant')).send({ period: '2026-12', units: [u('A-101')], dueDate: '2026-12-31' });
    assert.equal(gen.status, 201);
    const bill = (await api.get(`/api/v1/bills?unit=${u('A-101')}&period=2026-12`).set(as('accountant'))).body.data[0];
    const order = (await api.post('/api/v1/payments/orders').set(as('r1')).send({ bill: bill._id })).body.data;
    const signed = await sign('r1', order.orderId);
    await Promise.all([api.post('/api/v1/payments/verify').set(as('r1')).send(signed), webhook(captured(order.orderId, signed.paymentId))]);
    const after2 = (await api.get(`/api/v1/bills/${bill._id}`).set(as('accountant'))).body.data;
    assert.equal(after2.status, 'paid');
    assert.equal(after2.paid, after2.total);
    const p = await Payment.findOne({ providerOrderId: order.orderId }).lean();
    assert.equal(p.status, 'success');
    assert.equal(p.advanceAmount, 0, 'no surplus credited twice');
  });
});

describe('amenity booking confirmed by webhook', () => {
  test('a paid booking is confirmed from the webhook alone, and a late verify does not re-apply it', async () => {
    const { default: AmenityPayment } = await import('../src/modules/amenities/amenityPayment.model.js');
    const hall = await api.post('/api/v1/amenities').set(as('admin')).send({ name: 'Banquet', capacity: 1, openTime: '09:00', closeTime: '21:00', slotMinutes: 120, fee: 100000, deposit: 50000, paymentMode: 'online' });
    assert.equal(hall.status, 201, JSON.stringify(hall.body));
    const day = new Date(Date.now() + 4 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const b = await api.post('/api/v1/bookings').set(as('r1')).send({ amenity: hall.body.data._id, date: day, startTime: '09:00', endTime: '11:00' });
    assert.equal(b.body.data.status, 'payment_pending', JSON.stringify(b.body));
    const order = (await api.post(`/api/v1/bookings/${b.body.data._id}/pay`).set(as('r1'))).body.data;

    const hook = await webhook(captured(order.orderId));
    assert.equal(hook.body.data.handled, 'amenity', JSON.stringify(hook.body));
    const booking = (await api.get(`/api/v1/bookings/${b.body.data._id}`).set(as('r1'))).body.data;
    assert.equal(booking.status, 'confirmed');
    assert.equal(booking.paymentStatus, 'paid');

    const lateSig = await sign('r1', order.orderId);
    const late = await api.post('/api/v1/amenities/payments/verify').set(as('r1')).send(lateSig);
    assert.equal(late.status, 200, JSON.stringify(late.body));
    assert.equal(late.body.data.booking.status, 'confirmed');
    const pays = await AmenityPayment.find({ booking: b.body.data._id }).lean();
    assert.equal(pays.length, 2);
    assert.ok(pays.every((p) => p.status === 'success'));
  });
});

describe('event tickets and subscription invoices confirmed by webhook', () => {
  test('a paid event ticket settles from the webhook; the late verify is idempotent', async () => {
    const start = new Date(Date.now() + 3 * 86400000).toISOString();
    const end = new Date(Date.now() + 3 * 86400000 + 3 * 3600000).toISOString();
    const ev = await api.post('/api/v1/events').set(as('admin')).send({ title: 'Webhook night', startAt: start, endAt: end, ticketPrice: 50000, capacity: 20 });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const eid = ev.body.data._id;
    const rsvp = await api.post(`/api/v1/events/${eid}/rsvp`).set(as('r1')).send({ response: 'yes', paymentMode: 'online' });
    assert.equal(rsvp.body.data.paymentStatus, 'pending', JSON.stringify(rsvp.body));
    const order = (await api.post(`/api/v1/events/${eid}/pay`).set(as('r1'))).body.data;

    const hook = await webhook(captured(order.orderId));
    assert.equal(hook.body.data.handled, 'event', JSON.stringify(hook.body));
    const signed = (await api.post('/api/v1/events/payments/mock/sign').set(as('r1')).send({ orderId: order.orderId })).body.data;
    const late = await api.post('/api/v1/events/payments/verify').set(as('r1')).send(signed);
    assert.equal(late.status, 200, JSON.stringify(late.body));
    assert.equal(late.body.data.rsvp.paymentStatus, 'paid');
    assert.match(late.body.data.ticket.receiptNumber, /^EVT-\d{6}$/);
  });

  test('a subscription invoice paid online is settled from the webhook', async () => {
    const { default: Society } = await import('../src/modules/society/society.model.js');
    const { default: PlatformInvoice } = await import('../src/modules/subscriptions/platformInvoice.model.js');
    const subs = await import('../src/modules/subscriptions/subscriptions.service.js');
    const sid = s.admin.user.society._id;
    await Society.updateOne({ _id: sid }, { 'plan.name': 'basic', $unset: { 'plan.validUntil': 1 } });
    await subs.generateDueInvoices();
    const inv = await PlatformInvoice.findOne({ society: sid }).lean();
    assert.ok(inv, 'invoice generated');
    const order = await api.post(`/api/v1/subscription/invoices/${inv._id}/order`).set(as('admin'));
    assert.equal(order.status, 200, JSON.stringify(order.body));
    const hook = await webhook(captured(order.body.data.orderId));
    assert.equal(hook.body.data.handled, 'subscription', JSON.stringify(hook.body));
    assert.equal((await PlatformInvoice.findById(inv._id).lean()).status, 'paid');
  });
});
