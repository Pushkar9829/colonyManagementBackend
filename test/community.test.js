import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%test file for uploads\n');
const HOUR = 3600 * 1000;

const login = async (identifier) => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password: 'Password@123' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const h = (who) => bearer(s[who].accessToken);
const id = (who) => s[who].user._id;
const upload = async (who, folder, buf = PNG, name = 'photo.png') => {
  const res = await api.post('/api/v1/uploads').set(h(who)).field('folder', folder).attach('file', buf, name);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data._id;
};
const notificationsOf = async (who) => (await api.get('/api/v1/notifications').set(h(who))).body.data;
const at = (ms) => new Date(Date.now() + ms).toISOString();

async function makeSociety(prefix, name, residents) {
  const reg = await api.post('/api/v1/auth/register-society').send({
    society: { name },
    admin: { name: `${prefix} Admin`, email: `admin@${prefix}.test`, password: 'Password@123', designation: 'Secretary' },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const admin = reg.body.data;
  const a = bearer(admin.accessToken);
  const block = await api.post('/api/v1/blocks').set(a).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(a).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 4, areaSqft: 900 });
  const units = (await api.get('/api/v1/units').set(a)).body.data;
  const people = { admin };
  for (const [i, [key, role, phone]] of residents.entries()) {
    const body = { name: `${key} ${prefix}`, email: `${key}@${prefix}.test`, password: 'Password@123', role, phone };
    if (role === 'resident') Object.assign(body, { unit: units[i % units.length]._id, residentType: 'owner' });
    if (role !== 'resident') body.designation = `${key} desk`;
    // eslint-disable-next-line no-await-in-loop
    const res = await api.post('/api/v1/users').set(a).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // eslint-disable-next-line no-await-in-loop
    people[key] = await login(`${key}@${prefix}.test`);
  }
  return { people, blockId: block.body.data._id, units };
}

before(async () => {
  api = await setup();
  const A = await makeSociety('gv', 'Green Valley', [
    ['r1', 'resident', '9811100001'],
    ['r2', 'resident', '9811100002'],
    ['r3', 'resident', '9811100003'],
    ['fm', 'facility_manager', '9811100004'],
    ['guard', 'guard', '9811100005'],
    ['staff', 'staff', '9811100006'],
  ]);
  Object.assign(s, A.people);
  s.blockA = A.blockId;
  const B = await makeSociety('lv', 'Lake View', [['rb', 'resident', '9822200001']]);
  s.adminB = B.people.admin;
  s.rb = B.people.rb;
});
after(teardown);

// ------------------------------------------------------------------ notices
describe('notices: attachments, acknowledgements, scheduling', () => {
  test('ack-required notice with attachment tracks who has and has not acknowledged', async () => {
    const pdf = await upload('admin', 'notices', PDF, 'agm.pdf');
    const create = await api.post('/api/v1/notices').set(h('admin')).send({
      title: 'AGM minutes', body: 'Please read the AGM minutes.', category: 'meeting', requiresAck: true, sendEmail: true, attachments: [pdf],
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    assert.equal(create.body.data.attachments.length, 1);
    assert.equal(create.body.data.attachments[0].mimetype, 'application/pdf');
    s.ackNotice = create.body.data._id;

    const r1View = (await api.get('/api/v1/notices').set(h('r1'))).body.data.find((n) => n._id === s.ackNotice);
    assert.equal(r1View.requiresAck, true);
    assert.equal(r1View.isAcknowledged, false);
    assert.equal(r1View.ackCount, undefined, 'residents do not see counts');
    const pending = await api.get('/api/v1/notices?pendingAck=true').set(h('r1'));
    assert.deepEqual(pending.body.data.map((n) => n._id), [s.ackNotice]);

    const ack = await api.post(`/api/v1/notices/${s.ackNotice}/ack`).set(h('r1'));
    assert.equal(ack.status, 200);
    assert.equal(ack.body.data.isAcknowledged, true);
    assert.equal(ack.body.data.isRead, true);
    const again = await api.post(`/api/v1/notices/${s.ackNotice}/ack`).set(h('r1'));
    assert.equal(again.body.data.acknowledgedAt, ack.body.data.acknowledgedAt, 'second tap keeps the first timestamp');
    assert.equal((await api.get('/api/v1/notices?pendingAck=true').set(h('r1'))).body.data.length, 0);

    const status = await api.get(`/api/v1/notices/${s.ackNotice}/acks`).set(h('fm'));
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.data.acknowledged.map((p) => String(p.user)), [id('r1')]);
    const pendingIds = status.body.data.pending.map((p) => String(p.user));
    assert.ok(pendingIds.includes(id('r2')) && pendingIds.includes(id('guard')));
    assert.ok(!pendingIds.includes(id('admin')), 'author is not asked to acknowledge');
    assert.ok(!pendingIds.includes(id('rb')), 'other society never listed');

    assert.equal((await api.get(`/api/v1/notices/${s.ackNotice}/acks`).set(h('r1'))).status, 403);
    const remind = await api.post(`/api/v1/notices/${s.ackNotice}/acks/remind`).set(h('admin'));
    assert.equal(remind.body.data.reminded, pendingIds.length);
  });

  test('a notice without acknowledgement rejects ack', async () => {
    const n = await api.post('/api/v1/notices').set(h('admin')).send({ title: 'Lift service', body: 'Lift B off on Monday' });
    assert.equal((await api.post(`/api/v1/notices/${n.body.data._id}/ack`).set(h('r1'))).status, 400);
  });

  test('scheduled notices stay hidden until published by the job', async () => {
    const create = await api.post('/api/v1/notices').set(h('admin')).send({ title: 'Festival schedule', body: 'Coming soon', publishAt: at(2 * HOUR) });
    assert.equal(create.status, 201);
    assert.equal(create.body.data.scheduled, true);
    const nid = create.body.data._id;

    const residentList = (await api.get('/api/v1/notices').set(h('r2'))).body.data;
    assert.ok(!residentList.some((n) => n._id === nid));
    assert.equal((await api.post(`/api/v1/notices/${nid}/read`).set(h('r2'))).status, 404);
    assert.ok(!(await notificationsOf('r2')).some((n) => n.title === 'Festival schedule'), 'not notified yet');
    const scheduled = (await api.get('/api/v1/notices?scheduled=true').set(h('fm'))).body.data;
    assert.deepEqual(scheduled.map((n) => n._id), [nid]);

    const { publishDue } = await import('../src/modules/notices/notices.service.js');
    assert.equal((await publishDue(new Date())).published, 0);
    assert.equal((await publishDue(new Date(Date.now() + 3 * HOUR))).published, 1);
    assert.equal((await publishDue(new Date(Date.now() + 3 * HOUR))).published, 0, 'delivered once');
    assert.ok((await notificationsOf('r2')).some((n) => n.title === 'Festival schedule'));
    const { default: Notice } = await import('../src/modules/notices/notice.model.js');
    await Notice.updateOne({ _id: nid }, { publishAt: new Date(Date.now() - 1000) });
    assert.ok((await api.get('/api/v1/notices').set(h('r2'))).body.data.some((n) => n._id === nid));
    const reschedule = await api.patch(`/api/v1/notices/${nid}`).set(h('admin')).send({ publishAt: at(HOUR) });
    assert.equal(reschedule.status, 409, 'published notices cannot be rescheduled');
  });

  test('other societies and residents cannot manage notices', async () => {
    assert.equal((await api.post('/api/v1/notices').set(h('r1')).send({ title: 'Hello all', body: 'x' })).status, 403);
    assert.equal((await api.get(`/api/v1/notices/${s.ackNotice}/acks`).set(bearer(s.adminB.accessToken))).status, 404);
    assert.equal((await api.post(`/api/v1/notices/${s.ackNotice}/ack`).set(h('rb'))).status, 404);
  });
});

// ------------------------------------------------------------------ events
describe('events', () => {
  test('capacity, waitlist and promotion when someone cancels', async () => {
    const cover = await upload('admin', 'events');
    const ev = await api.post('/api/v1/events').set(h('admin')).send({
      title: 'Diwali dinner', venue: 'Clubhouse lawn', startAt: at(72 * HOUR), endAt: at(75 * HOUR), capacity: 3, maxGuests: 2, cover,
    });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    assert.ok(ev.body.data.cover.url);
    s.event = ev.body.data._id;
    const rsvp = (who, body) => api.post(`/api/v1/events/${s.event}/rsvp`).set(h(who)).send(body);

    const r1 = await rsvp('r1', { response: 'yes', guests: 1 });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.data.state, 'confirmed');
    assert.equal(r1.body.data.headcount, 2);
    assert.match(r1.body.data.ticketCode, /^[A-Z0-9]{8}$/);

    assert.equal((await rsvp('r2', { response: 'yes', guests: 3 })).status, 400, 'more guests than allowed');
    const r2 = await rsvp('r2', { response: 'yes', guests: 1 });
    assert.equal(r2.body.data.state, 'waitlisted', 'only 1 seat left for a party of 2');
    // a single person behind them fits the remaining seat
    const r3 = await rsvp('r3', { response: 'yes' });
    assert.equal(r3.body.data.state, 'confirmed');

    let detail = (await api.get(`/api/v1/events/${s.event}`).set(h('r2'))).body.data;
    assert.equal(detail.goingCount, 3);
    assert.equal(detail.isFull, true);
    assert.equal(detail.counts.waitlisted, 1);
    assert.equal(detail.myRsvp.state, 'waitlisted');

    const grow = await rsvp('r1', { response: 'yes', guests: 2 });
    assert.equal(grow.status, 409, 'cannot grow the party past capacity');

    const cancel = await api.delete(`/api/v1/events/${s.event}/rsvp`).set(h('r1'));
    assert.equal(cancel.body.data.state, 'declined');
    detail = (await api.get(`/api/v1/events/${s.event}`).set(h('r2'))).body.data;
    assert.equal(detail.myRsvp.state, 'confirmed', 'waitlisted party promoted');
    assert.equal(detail.goingCount, 3);
    assert.equal(detail.waitlistCount, 0);
    assert.ok((await notificationsOf('r2')).some((n) => n.title === "You're in: Diwali dinner"));

    // r1 changes their mind but the event is full again -> waitlist; raising capacity promotes them
    assert.equal((await rsvp('r1', { response: 'yes', guests: 1 })).body.data.state, 'waitlisted');
    assert.equal((await api.patch(`/api/v1/events/${s.event}`).set(h('fm')).send({ capacity: 2 })).status, 409, 'cannot shrink below confirmed');
    await api.patch(`/api/v1/events/${s.event}`).set(h('fm')).send({ capacity: 5 });
    assert.equal((await api.get(`/api/v1/events/${s.event}`).set(h('r1'))).body.data.myRsvp.state, 'confirmed');

    const list = await api.get(`/api/v1/events/${s.event}/rsvps`).set(h('fm'));
    assert.equal(list.body.data.filter((r) => r.state === 'confirmed').reduce((n, r) => n + r.headcount, 0), 5);
    assert.equal((await api.get(`/api/v1/events/${s.event}/rsvps`).set(h('r1'))).status, 403);
  });

  test('roles, audience and RSVP deadline', async () => {
    assert.equal((await api.post(`/api/v1/events/${s.event}/rsvp`).set(h('guard')).send({ response: 'yes' })).status, 403);
    assert.equal((await api.get('/api/v1/events').set(h('guard'))).status, 200, 'guards can view events');
    assert.equal((await api.post('/api/v1/events').set(h('r1')).send({ title: 'My party', startAt: at(HOUR), endAt: at(2 * HOUR) })).status, 403);

    const staffOnly = await api.post('/api/v1/events').set(h('fm')).send({ title: 'Staff lunch', startAt: at(5 * HOUR), endAt: at(6 * HOUR), audience: { type: 'roles', roles: ['staff', 'guard'] } });
    assert.equal(staffOnly.status, 201);
    assert.equal((await api.get(`/api/v1/events/${staffOnly.body.data._id}`).set(h('r1'))).status, 404);
    assert.ok((await api.get('/api/v1/events').set(h('guard'))).body.data.some((e) => e._id === staffOnly.body.data._id));

    const closed = await api.post('/api/v1/events').set(h('fm')).send({ title: 'Closed RSVPs', startAt: at(48 * HOUR), endAt: at(49 * HOUR), rsvpDeadline: at(-HOUR) });
    assert.equal(closed.status, 201);
    assert.equal((await api.post(`/api/v1/events/${closed.body.data._id}/rsvp`).set(h('r1')).send({ response: 'yes' })).status, 409);
    const bad = await api.post('/api/v1/events').set(h('fm')).send({ title: 'Backwards', startAt: at(5 * HOUR), endAt: at(4 * HOUR) });
    assert.equal(bad.status, 422);

    assert.equal((await api.get(`/api/v1/events/${s.event}`).set(bearer(s.adminB.accessToken))).status, 404, 'tenant isolation');
    const month = await api.get('/api/v1/events').query({ from: at(-24 * HOUR), to: at(30 * 24 * HOUR) }).set(h('r1'));
    assert.ok(month.body.data.some((e) => e._id === s.event));
  });

  test('paid tickets: online with mock provider, pay at venue, QR check-in', async () => {
    const ev = await api.post('/api/v1/events').set(h('fm')).send({ title: 'Music night', startAt: at(30 * HOUR), endAt: at(33 * HOUR), ticketPrice: 50000, capacity: 20 });
    const eid = ev.body.data._id;
    s.paidEvent = eid;
    const r1 = await api.post(`/api/v1/events/${eid}/rsvp`).set(h('r1')).send({ response: 'yes', guests: 1, paymentMode: 'online' });
    assert.equal(r1.body.data.amountDue, 100000);
    assert.equal(r1.body.data.paymentStatus, 'pending');

    const order = await api.post(`/api/v1/events/${eid}/pay`).set(h('r1'));
    assert.equal(order.status, 200, JSON.stringify(order.body));
    assert.equal(order.body.data.amount, 100000);
    assert.equal(order.body.data.provider, 'mock');
    const forged = await api.post('/api/v1/events/payments/verify').set(h('r1')).send({ orderId: order.body.data.orderId, paymentId: 'mock_pay_forged', signature: 'f'.repeat(64) });
    assert.equal(forged.status, 400);
    const order2 = await api.post(`/api/v1/events/${eid}/pay`).set(h('r1'));
    const signed = await api.post('/api/v1/events/payments/mock/sign').set(h('r1')).send({ orderId: order2.body.data.orderId });
    assert.equal((await api.post('/api/v1/events/payments/verify').set(h('r2')).send(signed.body.data)).status, 404, "someone else's order");
    const paid = await api.post('/api/v1/events/payments/verify').set(h('r1')).send(signed.body.data);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.rsvp.paymentStatus, 'paid');
    assert.match(paid.body.data.ticket.receiptNumber, /^EVT-\d{6}$/);
    const replay = await api.post('/api/v1/events/payments/verify').set(h('r1')).send(signed.body.data);
    assert.equal(replay.body.data.ticket.receiptNumber, paid.body.data.ticket.receiptNumber, 'idempotent');
    assert.equal((await api.post(`/api/v1/events/${eid}/pay`).set(h('r1'))).status, 409, 'already paid');
    assert.equal((await api.delete(`/api/v1/events/${eid}/rsvp`).set(h('r1'))).status, 409, 'paid ticket cannot be cancelled in-app');

    const ticket = await api.get(`/api/v1/events/${eid}/ticket`).set(h('r1'));
    assert.match(ticket.body.data.qrPayload, new RegExp(`^colonyhub:event:${eid}:[A-Z0-9]{8}$`));
    const check = await api.post(`/api/v1/events/${eid}/check-in`).set(h('fm')).send({ code: ticket.body.data.qrPayload });
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.ok(check.body.data.checkedInAt);
    assert.equal(check.body.data.attendedCount, 2);
    assert.equal((await api.post(`/api/v1/events/${eid}/check-in`).set(h('fm')).send({ code: ticket.body.data.ticketCode })).status, 409, 'no double check-in');
    assert.equal((await api.post(`/api/v1/events/${s.event}/check-in`).set(h('fm')).send({ code: ticket.body.data.qrPayload })).status, 400, 'ticket for another event');

    // pay at venue
    const r2 = await api.post(`/api/v1/events/${eid}/rsvp`).set(h('r2')).send({ response: 'yes' });
    assert.equal(r2.body.data.paymentMode, 'venue');
    const pending = await api.post(`/api/v1/events/${eid}/check-in`).set(h('fm')).send({ code: r2.body.data.ticketCode });
    assert.equal(pending.status, 409);
    assert.equal(pending.body.error.code, 'PAYMENT_PENDING');
    const collected = await api.post(`/api/v1/events/${eid}/check-in`).set(h('fm')).send({ code: r2.body.data.ticketCode, collect: 'cash' });
    assert.equal(collected.status, 200, JSON.stringify(collected.body));
    assert.equal(collected.body.data.paymentStatus, 'paid');

    const tickets = await api.get(`/api/v1/events/${eid}/tickets`).set(h('fm'));
    assert.equal(tickets.body.meta.total, 2);
    assert.deepEqual(tickets.body.data.map((t) => t.method).sort(), ['cash', 'online']);
    const detail = (await api.get(`/api/v1/events/${eid}`).set(h('admin'))).body.data;
    assert.equal(detail.counts.collected, 150000);
    assert.equal(detail.counts.checkedIn, 2);
    assert.equal((await api.patch(`/api/v1/events/${eid}`).set(h('fm')).send({ ticketPrice: 1000 })).status, 409, 'price locked after payment');
    assert.equal((await api.post(`/api/v1/events/${eid}/check-in`).set(h('r1')).send({ code: 'ABCDEFGH' })).status, 403);
  });

  test('reminders 24h before, gallery after start, cancellation', async () => {
    const ev = await api.post('/api/v1/events').set(h('fm')).send({ title: 'Yoga morning', startAt: at(3 * HOUR), endAt: at(4 * HOUR) });
    const eid = ev.body.data._id;
    await api.post(`/api/v1/events/${eid}/rsvp`).set(h('r3')).send({ response: 'yes' });
    await api.post(`/api/v1/events/${eid}/rsvp`).set(h('r2')).send({ response: 'maybe' });
    const { sendReminders } = await import('../src/modules/events/events.service.js');
    const sent = await sendReminders();
    assert.ok(sent.reminded >= 2);
    assert.equal((await sendReminders()).reminded, 0, 'reminder sent once');
    assert.ok((await notificationsOf('r3')).some((n) => n.title === 'Tomorrow: Yoga morning'));

    const photo = await upload('r3', 'events');
    assert.equal((await api.post(`/api/v1/events/${eid}/photos`).set(h('r3')).send({ photos: [photo] })).status, 409, 'not started yet');
    const { default: Event } = await import('../src/modules/events/event.model.js');
    await Event.updateOne({ _id: eid }, { startAt: new Date(Date.now() - 2 * HOUR), endAt: new Date(Date.now() - HOUR) });
    const added = await api.post(`/api/v1/events/${eid}/photos`).set(h('r3')).send({ photos: [photo] });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.data.gallery.length, 1);
    const r1photo = await upload('r1', 'events');
    assert.equal((await api.post(`/api/v1/events/${eid}/photos`).set(h('r1')).send({ photos: [r1photo] })).status, 403, 'non-attendee');
    const photoId = added.body.data.gallery[0]._id;
    assert.equal((await api.delete(`/api/v1/events/${eid}/photos/${photoId}`).set(h('r2'))).status, 403);
    assert.equal((await api.delete(`/api/v1/events/${eid}/photos/${photoId}`).set(h('fm'))).body.data.gallery.length, 0);

    const cancelled = await api.post(`/api/v1/events/${s.paidEvent}/cancel`).set(h('fm')).send({ reason: 'Rain forecast' });
    assert.equal(cancelled.body.data.status, 'cancelled');
    const mine = (await api.get(`/api/v1/events/${s.paidEvent}`).set(h('r1'))).body.data.myRsvp;
    assert.equal(mine.state, 'cancelled');
    assert.equal(mine.paymentStatus, 'refund_due');
    assert.ok((await notificationsOf('r1')).some((n) => n.title === 'Cancelled: Music night'));
  });
});

// ------------------------------------------------------------------ forum
describe('forum', () => {
  test('topics, replies, likes, mentions and reply notifications', async () => {
    const cats = await api.get('/api/v1/forum/categories').set(h('r1'));
    assert.ok(cats.body.data.length >= 3, 'default categories created');
    s.cat = cats.body.data[0]._id;
    const t = await api.post('/api/v1/forum/topics').set(h('r1')).send({
      category: s.cat, title: 'Best pediatrician nearby?', body: 'Looking for suggestions.\nThanks! https://example.com', mentions: [id('r2'), id('rb')],
    });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    s.topic = t.body.data._id;
    assert.equal(t.body.data.canEdit, true);
    assert.ok((await notificationsOf('r2')).some((n) => n.type === 'forum' && /mentioned you/.test(n.title)));
    assert.ok(!(await notificationsOf('rb')).some((n) => n.type === 'forum'), 'cannot mention another society');

    const reply = await api.post(`/api/v1/forum/topics/${s.topic}/replies`).set(h('r2')).send({ body: 'Dr. Rao at City Clinic' });
    assert.equal(reply.status, 201);
    s.reply = reply.body.data._id;
    assert.ok((await notificationsOf('r1')).some((n) => n.type === 'forum' && /replied/.test(n.title)));

    const like = await api.post(`/api/v1/forum/topics/${s.topic}/like`).set(h('r2'));
    assert.deepEqual(like.body.data, { liked: true, likeCount: 1 });
    assert.deepEqual((await api.post(`/api/v1/forum/topics/${s.topic}/like`).set(h('r2'))).body.data, { liked: false, likeCount: 0 });
    await api.post(`/api/v1/forum/replies/${s.reply}/like`).set(h('r1'));

    const detail = await api.get(`/api/v1/forum/topics/${s.topic}`).set(h('r1'));
    assert.equal(detail.body.data.replyCount, 1);
    assert.equal(detail.body.data.replies[0].likeCount, 1);
    assert.equal(detail.body.data.replies[0].likedByMe, true);
    assert.equal(detail.body.data.likes, undefined, 'like arrays are not exposed');

    assert.equal((await api.post(`/api/v1/forum/topics/${s.topic}/resolve`).set(h('r2')).send({ resolved: true })).status, 403);
    assert.equal((await api.post(`/api/v1/forum/topics/${s.topic}/resolve`).set(h('r1')).send({ resolved: true })).body.data.resolved, true);
  });

  test('15-minute edit / delete window', async () => {
    assert.equal((await api.patch(`/api/v1/forum/replies/${s.reply}`).set(h('r2')).send({ body: 'Dr. Rao, City Clinic (Mon-Sat)' })).status, 200);
    assert.equal((await api.patch(`/api/v1/forum/replies/${s.reply}`).set(h('r1')).send({ body: 'hijack' })).status, 403, "not someone else's");
    const { default: ForumReply } = await import('../src/modules/forum/forumReply.model.js');
    const { default: ForumTopic } = await import('../src/modules/forum/forumTopic.model.js');
    await ForumReply.collection.updateOne({ _id: new ForumReply.base.Types.ObjectId(s.reply) }, { $set: { createdAt: new Date(Date.now() - 20 * 60000) } });
    await ForumTopic.collection.updateOne({ _id: new ForumTopic.base.Types.ObjectId(s.topic) }, { $set: { createdAt: new Date(Date.now() - 20 * 60000) } });
    assert.equal((await api.patch(`/api/v1/forum/replies/${s.reply}`).set(h('r2')).send({ body: 'late edit' })).status, 403);
    assert.equal((await api.delete(`/api/v1/forum/replies/${s.reply}`).set(h('r2'))).status, 403);
    assert.equal((await api.patch(`/api/v1/forum/topics/${s.topic}`).set(h('r1')).send({ title: 'Edited title here' })).status, 403);
    const detail = (await api.get(`/api/v1/forum/topics/${s.topic}`).set(h('r1'))).body.data;
    assert.equal(detail.canEdit, false);

    const fresh = await api.post(`/api/v1/forum/topics/${s.topic}/replies`).set(h('r3')).send({ body: 'oops, wrong thread' });
    assert.equal((await api.delete(`/api/v1/forum/replies/${fresh.body.data._id}`).set(h('r3'))).status, 204);
    assert.equal((await api.get(`/api/v1/forum/topics/${s.topic}`).set(h('r1'))).body.data.replyCount, 1);
  });

  test('moderation: pin, lock, reports queue, removal', async () => {
    assert.equal((await api.post(`/api/v1/forum/topics/${s.topic}/pin`).set(h('r1')).send({ value: true })).status, 403);
    assert.equal((await api.post(`/api/v1/forum/topics/${s.topic}/pin`).set(h('fm')).send({ value: true })).body.data.pinned, true);
    const other = await api.post('/api/v1/forum/topics').set(h('r2')).send({ category: s.cat, title: 'Parking in visitor slots', body: 'Who keeps parking there?' });
    const list = (await api.get('/api/v1/forum/topics').set(h('r3'))).body.data;
    assert.equal(list[0]._id, s.topic, 'pinned first');

    await api.post(`/api/v1/forum/topics/${s.topic}/lock`).set(h('fm')).send({ value: true });
    assert.equal((await api.post(`/api/v1/forum/topics/${s.topic}/replies`).set(h('r3')).send({ body: 'me too' })).status, 403);
    assert.equal((await api.post(`/api/v1/forum/topics/${s.topic}/replies`).set(h('fm')).send({ body: 'Locking this, thanks all' })).status, 201, 'moderators may still reply');

    const oid = other.body.data._id;
    assert.equal((await api.post('/api/v1/forum/reports').set(h('r2')).send({ targetType: 'topic', targetId: oid, reason: 'spam' })).status, 400, 'own post');
    assert.equal((await api.post('/api/v1/forum/reports').set(h('r1')).send({ targetType: 'topic', targetId: oid, reason: 'abusive', note: 'rude' })).status, 201);
    assert.equal((await api.post('/api/v1/forum/reports').set(h('r1')).send({ targetType: 'topic', targetId: oid, reason: 'spam' })).status, 409);
    await api.post('/api/v1/forum/reports').set(h('r3')).send({ targetType: 'topic', targetId: oid, reason: 'abusive' });
    assert.equal((await api.post('/api/v1/forum/reports').set(h('rb')).send({ targetType: 'topic', targetId: oid, reason: 'spam' })).status, 404, 'other society');

    assert.equal((await api.get('/api/v1/forum/reports').set(h('r1'))).status, 403);
    const queue = await api.get('/api/v1/forum/reports').set(h('fm'));
    assert.equal(queue.body.data.length, 1);
    assert.equal(queue.body.data[0].count, 2);
    assert.equal(queue.body.data[0].content.title, 'Parking in visitor slots');

    const removed = await api.post('/api/v1/forum/reports/resolve').set(h('fm')).send({ targetType: 'topic', targetId: oid, action: 'remove', reason: 'Be kind' });
    assert.equal(removed.body.data.resolved, 2);
    assert.ok(!(await api.get('/api/v1/forum/topics').set(h('r3'))).body.data.some((t) => t._id === oid));
    assert.equal((await api.get(`/api/v1/forum/topics/${oid}`).set(h('r3'))).status, 404);
    assert.equal((await api.get(`/api/v1/forum/topics/${oid}`).set(h('r2'))).body.data.body, '', 'author sees placeholder');
    assert.ok((await notificationsOf('r2')).some((n) => /removed by a moderator/.test(n.title)));
    assert.equal((await api.get('/api/v1/forum/reports').set(h('fm'))).body.data.length, 0);
  });

  test('guards and staff cannot use the forum; other societies cannot see topics', async () => {
    assert.equal((await api.get('/api/v1/forum/topics').set(h('guard'))).status, 403);
    assert.equal((await api.get('/api/v1/forum/topics').set(h('staff'))).status, 403);
    assert.equal((await api.get(`/api/v1/forum/topics/${s.topic}`).set(h('rb'))).status, 404);
    assert.equal((await api.get('/api/v1/forum/topics').set(h('rb'))).body.data.length, 0);
  });
});

// ------------------------------------------------------------------ directory
describe('directory privacy', () => {
  test('nobody is listed until they opt in', async () => {
    const mine = await api.get('/api/v1/directory/me').set(h('r1'));
    assert.equal(mine.body.data.listed, false);
    assert.equal((await api.get('/api/v1/directory').set(h('r2'))).body.data.length, 0);
  });

  test('hidden fields are never returned or searchable', async () => {
    await api.patch('/api/v1/directory/me').set(h('r1')).send({ listed: true, profession: 'Pediatrician', skills: ['First aid'], showProfession: false, showPhone: false, showEmail: false });
    const list = await api.get('/api/v1/directory').set(h('r2'));
    assert.equal(list.body.data.length, 1);
    const entry = list.body.data[0];
    assert.equal(entry.name, 'r1 gv');
    assert.ok(entry.units.length);
    for (const hidden of ['phone', 'email', 'profession', 'skills', 'about']) assert.ok(!(hidden in entry), `${hidden} must not be present`);
    assert.equal((await api.get('/api/v1/directory?search=pediatric').set(h('r2'))).body.data.length, 0, 'hidden profession not searchable');
    assert.equal((await api.get('/api/v1/directory?search=r1').set(h('r2'))).body.data.length, 1);
    assert.equal((await api.get(`/api/v1/directory?block=${s.blockA}`).set(h('r2'))).body.data.length, 1);

    await api.patch('/api/v1/directory/me').set(h('r1')).send({ showProfession: true, showPhone: true });
    const shown = (await api.get('/api/v1/directory?search=pediatric').set(h('r2'))).body.data;
    assert.equal(shown.length, 1);
    assert.equal(shown[0].phone, '9811100001');
    assert.equal(shown[0].profession, 'Pediatrician');
    assert.ok(!('email' in shown[0]));

    // the admin gets no special view through the directory API
    assert.ok(!('email' in (await api.get('/api/v1/directory').set(h('admin'))).body.data[0]));
    assert.equal((await api.get('/api/v1/directory').set(h('rb'))).body.data.length, 0, 'tenant isolation');
    await api.patch('/api/v1/directory/me').set(h('r1')).send({ listed: false });
    assert.equal((await api.get('/api/v1/directory').set(h('r2'))).body.data.length, 0);
    await api.patch('/api/v1/directory/me').set(h('r1')).send({ listed: true });
  });

  test('committee and staff contacts show designations, phone only if allowed', async () => {
    const c = await api.get('/api/v1/directory/contacts').set(h('r2'));
    const admin = c.body.data.committee.find((p) => p.role === 'admin');
    assert.equal(admin.designation, 'Secretary');
    assert.ok(!('phone' in admin) && !('email' in admin));
    assert.ok(c.body.data.staff.some((p) => p.role === 'guard'));
    assert.equal((await api.get('/api/v1/directory').set(h('guard'))).status, 403);
  });
});

// ------------------------------------------------------------------ lost & found
describe('lost & found', () => {
  test('claim flow: claim, private claims, confirm, others declined', async () => {
    const photo = await upload('r1', 'lostfound');
    const item = await api.post('/api/v1/lost-found').set(h('r1')).send({ kind: 'found', title: 'Car keys near gym', category: 'keys', location: 'Gym entrance', photos: [photo] });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    const iid = item.body.data._id;
    assert.equal(item.body.data.photos.length, 1);
    assert.equal((await api.post(`/api/v1/lost-found/${iid}/claims`).set(h('r1')).send({ message: 'mine actually' })).status, 400);

    const c2 = await api.post(`/api/v1/lost-found/${iid}/claims`).set(h('r2')).send({ message: 'Honda key with a red tag' });
    assert.equal(c2.status, 201);
    assert.equal((await api.post(`/api/v1/lost-found/${iid}/claims`).set(h('r2')).send({ message: 'again again' })).status, 409);
    await api.post(`/api/v1/lost-found/${iid}/claims`).set(h('r3')).send({ message: 'Maybe mine, blue keychain' });
    assert.ok((await notificationsOf('r1')).some((n) => n.type === 'lostfound'));

    const asR2 = (await api.get(`/api/v1/lost-found/${iid}`).set(h('r2'))).body.data;
    assert.equal(asR2.claims.length, 1, "claimants don't see each other's claims");
    const asPoster = (await api.get(`/api/v1/lost-found/${iid}`).set(h('r1'))).body.data;
    assert.equal(asPoster.claims.length, 2);
    const claimId = asPoster.claims.find((c) => c.by._id === id('r2'))._id;

    assert.equal((await api.post(`/api/v1/lost-found/${iid}/claims/${claimId}/accept`).set(h('r3'))).status, 403);
    const done = await api.post(`/api/v1/lost-found/${iid}/claims/${claimId}/accept`).set(h('r1'));
    assert.equal(done.body.data.status, 'resolved');
    assert.deepEqual(done.body.data.claims.map((c) => c.status).sort(), ['accepted', 'rejected']);
    assert.equal((await api.post(`/api/v1/lost-found/${iid}/claims`).set(h('r3')).send({ message: 'one more try' })).status, 409);
    assert.ok((await notificationsOf('r2')).some((n) => /was confirmed/.test(n.title)));
    assert.ok(!(await api.get('/api/v1/lost-found').set(h('r3'))).body.data.some((i) => i._id === iid), 'resolved items leave the open list');
  });

  test('posts expire after 30 days and can be reopened', async () => {
    const item = await api.post('/api/v1/lost-found').set(h('r2')).send({ kind: 'lost', title: 'Blue umbrella', date: '2026-10-01' });
    const { default: Item } = await import('../src/modules/lostFound/lostFoundItem.model.js');
    const { expireOld } = await import('../src/modules/lostFound/lostFound.service.js');
    const created = await Item.findById(item.body.data._id).lean();
    assert.ok(created.expiresAt - created.createdAt >= 29.9 * 24 * HOUR);
    assert.equal((await expireOld()).expired, 0);
    assert.ok((await expireOld(new Date(Date.now() + 31 * 24 * HOUR))).expired >= 1);
    assert.equal((await Item.findById(item.body.data._id).lean()).status, 'expired');
    const reopened = await api.post(`/api/v1/lost-found/${item.body.data._id}/status`).set(h('r2')).send({ status: 'open' });
    assert.equal(reopened.body.data.status, 'open');
    assert.equal((await api.get(`/api/v1/lost-found/${item.body.data._id}`).set(h('rb'))).status, 404);
    assert.equal((await api.get('/api/v1/lost-found').set(h('guard'))).status, 403);
  });
});

// ------------------------------------------------------------------ marketplace
describe('marketplace', () => {
  test('listing lifecycle with private phone, chat contact and sold', async () => {
    const photo = await upload('r1', 'marketplace');
    const l = await api.post('/api/v1/marketplace/listings').set(h('r1')).send({ type: 'sell', title: 'Study table', category: 'furniture', condition: 'good', price: 250000, photos: [photo] });
    assert.equal(l.status, 201, JSON.stringify(l.body));
    const lid = l.body.data._id;
    let asBuyer = (await api.get(`/api/v1/marketplace/listings/${lid}`).set(h('r2'))).body.data;
    assert.ok(!('phone' in asBuyer.seller), 'phone hidden by default');
    assert.equal(asBuyer.reportCount, undefined);
    await api.patch(`/api/v1/marketplace/listings/${lid}`).set(h('r1')).send({ showPhone: true });
    asBuyer = (await api.get(`/api/v1/marketplace/listings/${lid}`).set(h('r2'))).body.data;
    assert.equal(asBuyer.seller.phone, '9811100001');
    assert.equal((await api.patch(`/api/v1/marketplace/listings/${lid}`).set(h('r2')).send({ price: 1 })).status, 403);

    const contact = await api.post(`/api/v1/marketplace/listings/${lid}/contact`).set(h('r2')).send({ message: 'Is this available?' });
    assert.equal(contact.status, 200, JSON.stringify(contact.body));
    assert.equal(contact.body.data.message.context.type, 'listing');
    const sellerInbox = (await api.get('/api/v1/chat/conversations').set(h('r1'))).body.data;
    assert.ok(sellerInbox.some((c) => c._id === contact.body.data.conversation._id && c.unread === 1));

    assert.equal((await api.post(`/api/v1/marketplace/listings/${lid}/status`).set(h('r1')).send({ status: 'sold' })).body.data.status, 'sold');
    assert.ok(!(await api.get('/api/v1/marketplace/listings').set(h('r3'))).body.data.some((x) => x._id === lid));
    assert.ok((await api.get('/api/v1/marketplace/listings?mine=true').set(h('r1'))).body.data.some((x) => x._id === lid));
    assert.equal((await api.post(`/api/v1/marketplace/listings/${lid}/contact`).set(h('r3')).send({})).status, 409, 'sold');

    const free = await api.post('/api/v1/marketplace/listings').set(h('r3')).send({ type: 'free', title: 'Old magazines', price: 5000 });
    assert.equal(free.body.data.price, 0, 'free listings are free');
  });

  test('reports and moderator removal', async () => {
    const l = await api.post('/api/v1/marketplace/listings').set(h('r2')).send({ type: 'services', title: 'Crypto doubling scheme', price: 100, priceUnit: 'per_month' });
    const lid = l.body.data._id;
    assert.equal((await api.post(`/api/v1/marketplace/listings/${lid}/report`).set(h('r3')).send({ reason: 'scam' })).status, 201);
    assert.equal((await api.post(`/api/v1/marketplace/listings/${lid}/report`).set(h('r3')).send({ reason: 'spam' })).status, 409);
    assert.equal((await api.get('/api/v1/marketplace/reports').set(h('r1'))).status, 403);
    const reports = await api.get('/api/v1/marketplace/reports').set(h('fm'));
    assert.equal(reports.body.data.length, 1);
    const resolved = await api.post(`/api/v1/marketplace/reports/${reports.body.data[0]._id}/resolve`).set(h('fm')).send({ action: 'remove', reason: 'Scam' });
    assert.equal(resolved.body.data.status, 'actioned');
    assert.equal((await api.get(`/api/v1/marketplace/listings/${lid}`).set(h('r3'))).status, 404);
    assert.equal((await api.get(`/api/v1/marketplace/listings/${lid}`).set(h('r2'))).body.data.status, 'removed');
    assert.equal((await api.post(`/api/v1/marketplace/listings/${lid}/status`).set(h('r2')).send({ status: 'active' })).status, 409);
    assert.ok((await notificationsOf('r2')).some((n) => /was removed/.test(n.title)));
    assert.equal((await api.get(`/api/v1/marketplace/listings/${lid}`).set(h('rb'))).status, 404);
  });

  test('local businesses need admin approval', async () => {
    const b = await api.post('/api/v1/marketplace/businesses').set(h('r3')).send({ name: "Asha's Tiffin", category: 'tiffin', priceNote: '₹3,000 / month', contactPhone: '9876500000' });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(b.body.data.status, 'pending');
    const bid = b.body.data._id;
    assert.ok(!(await api.get('/api/v1/marketplace/businesses').set(h('r1'))).body.data.some((x) => x._id === bid));
    assert.equal((await api.post(`/api/v1/marketplace/businesses/${bid}/review`).set(h('fm')).send({ status: 'approved' })).status, 403, 'admin only');
    assert.equal((await api.post(`/api/v1/marketplace/businesses/${bid}/review`).set(h('admin')).send({ status: 'rejected' })).status, 400, 'reason required');
    const pend = await api.get('/api/v1/marketplace/businesses?status=pending').set(h('admin'));
    assert.ok(pend.body.data.some((x) => x._id === bid));
    assert.equal((await api.post(`/api/v1/marketplace/businesses/${bid}/review`).set(h('admin')).send({ status: 'approved' })).body.data.status, 'approved');
    assert.ok((await api.get('/api/v1/marketplace/businesses').set(h('r1'))).body.data.some((x) => x._id === bid));
    const edited = await api.patch(`/api/v1/marketplace/businesses/${bid}`).set(h('r3')).send({ priceNote: '₹3,500 / month' });
    assert.equal(edited.body.data.status, 'pending', 'edits need re-approval');
    assert.equal((await api.get('/api/v1/marketplace/businesses').set(h('rb'))).body.data.length, 0);
  });
});

// ------------------------------------------------------------------ chat
describe('chat & intercom', () => {
  test('two residents chat with unread counts and read receipts', async () => {
    const open = await api.post('/api/v1/chat/conversations').set(h('r3')).send({ userId: id('r1') });
    assert.equal(open.status, 200, JSON.stringify(open.body));
    const cid = open.body.data._id;
    s.conv = cid;
    const again = await api.post('/api/v1/chat/conversations').set(h('r1')).send({ userId: id('r3') });
    assert.equal(again.body.data._id, cid, 'same thread from either side');

    const photo = await upload('r3', 'chat');
    const m1 = await api.post(`/api/v1/chat/conversations/${cid}/messages`).set(h('r3')).send({ text: 'Hi neighbour!' });
    assert.equal(m1.status, 201);
    assert.equal(m1.body.data.mine, true);
    await api.post(`/api/v1/chat/conversations/${cid}/messages`).set(h('r3')).send({ attachments: [photo] });
    const pdf = await upload('r3', 'chat', PDF, 'doc.pdf');
    assert.equal((await api.post(`/api/v1/chat/conversations/${cid}/messages`).set(h('r3')).send({ attachments: [pdf] })).status, 400, 'images only');
    assert.equal((await api.post(`/api/v1/chat/conversations/${cid}/messages`).set(h('r3')).send({ text: '  ' })).status, 422);

    const before = (await api.get('/api/v1/chat/unread').set(h('r1'))).body.data.unread;
    assert.ok(before >= 2);
    const thread = await api.get(`/api/v1/chat/conversations/${cid}/messages`).set(h('r1'));
    assert.equal(thread.body.data.length, 2);
    assert.equal(thread.body.data[0].mine, false);
    assert.equal(thread.body.data[1].attachments.length, 1);
    await api.post(`/api/v1/chat/conversations/${cid}/read`).set(h('r1'));
    assert.equal((await api.get('/api/v1/chat/unread').set(h('r1'))).body.data.unread, before - 2);
    const r3view = (await api.get(`/api/v1/chat/conversations/${cid}`).set(h('r3'))).body.data;
    assert.ok(r3view.otherReadAt, 'sender sees that it was read');
    assert.equal(r3view.title, 'r1 gv');
    const chatNotes = (await notificationsOf('r1')).filter((n) => n.type === 'chat' && /r3 gv/.test(n.title));
    assert.equal(chatNotes.length, 1, 'one notification per unread burst');
  });

  test('cannot message another society, a stranger cannot read the thread', async () => {
    assert.equal((await api.post('/api/v1/chat/conversations').set(h('r1')).send({ userId: id('rb') })).status, 404);
    assert.equal((await api.get(`/api/v1/chat/conversations/${s.conv}/messages`).set(h('r2'))).status, 404);
    assert.equal((await api.get(`/api/v1/chat/conversations/${s.conv}`).set(h('rb'))).status, 404);
    assert.equal((await api.post(`/api/v1/chat/conversations/${s.conv}/messages`).set(h('admin')).send({ text: 'snoop' })).status, 404);
    assert.equal((await api.post('/api/v1/chat/conversations').set(h('r1')).send({ userId: id('r1') })).status, 400);
  });

  test('blocked users cannot message', async () => {
    assert.equal((await api.post('/api/v1/chat/blocks').set(h('r1')).send({ userId: id('r3') })).status, 200);
    assert.equal((await api.post(`/api/v1/chat/conversations/${s.conv}/messages`).set(h('r3')).send({ text: 'hello?' })).status, 403);
    assert.equal((await api.post(`/api/v1/chat/conversations/${s.conv}/messages`).set(h('r1')).send({ text: 'hello?' })).status, 403, 'blocking works both ways');
    const blocks = await api.get('/api/v1/chat/blocks').set(h('r1'));
    assert.equal(blocks.body.data[0].user.name, 'r3 gv');
    assert.equal((await api.post('/api/v1/chat/blocks').set(h('r1')).send({ userId: id('rb') })).status, 404);
    await api.delete(`/api/v1/chat/blocks/${id('r3')}`).set(h('r1'));
    assert.equal((await api.post(`/api/v1/chat/conversations/${s.conv}/messages`).set(h('r3')).send({ text: 'thanks' })).status, 201);
  });

  test('intercom: resident messages the security desk, any guard answers as the desk', async () => {
    assert.equal((await api.post('/api/v1/chat/conversations').set(h('guard')).send({ userId: id('r1') })).status, 403, 'guards use the desk');
    assert.equal((await api.post('/api/v1/chat/conversations').set(h('r1')).send({ userId: id('guard') })).status, 400);
    const desk = await api.post('/api/v1/chat/desk').set(h('r2')).send({ desk: 'security' });
    assert.equal(desk.body.data.title, 'Security desk');
    const did = desk.body.data._id;
    await api.post(`/api/v1/chat/conversations/${did}/messages`).set(h('r2')).send({ text: 'Expecting a courier at 5pm' });

    const guardInbox = (await api.get('/api/v1/chat/conversations').set(h('guard'))).body.data;
    const deskConv = guardInbox.find((c) => c._id === did);
    assert.ok(deskConv && deskConv.asDesk && deskConv.unread === 1);
    assert.match(deskConv.title, /r2 gv/);
    assert.equal((await api.get('/api/v1/chat/unread').set(h('guard'))).body.data.unread, 1);
    const reply = await api.post(`/api/v1/chat/conversations/${did}/messages`).set(h('guard')).send({ text: 'Noted, will call you' });
    assert.equal(reply.body.data.asDesk, true);
    const r2thread = (await api.get(`/api/v1/chat/conversations/${did}/messages`).set(h('r2'))).body.data;
    assert.equal(r2thread[1].mine, false);
    assert.equal(r2thread[1].asDesk, true);
    assert.equal((await api.get(`/api/v1/chat/conversations/${did}`).set(h('fm'))).status, 404, 'management is not on the security desk');
    assert.equal((await api.get(`/api/v1/chat/conversations/${did}`).set(h('r1'))).status, 404);

    // a guard can start a desk thread with a resident (e.g. parcel at the gate)
    const toR1 = await api.post('/api/v1/chat/desk').set(h('guard')).send({ desk: 'security', member: id('r1') });
    assert.equal(toR1.status, 200);
    assert.equal((await api.post('/api/v1/chat/desk').set(h('guard')).send({ desk: 'security', member: id('rb') })).status, 404);
    const mgmt = await api.post('/api/v1/chat/desk').set(h('r1')).send({ desk: 'management' });
    await api.post(`/api/v1/chat/conversations/${mgmt.body.data._id}/messages`).set(h('r1')).send({ text: 'Water leak in basement' });
    assert.ok((await api.get('/api/v1/chat/conversations').set(h('fm'))).body.data.some((c) => c._id === mgmt.body.data._id));
  });

  test('contacts list desks and opted-in neighbours without phone numbers', async () => {
    const c = await api.get('/api/v1/chat/contacts').set(h('r2'));
    assert.deepEqual(c.body.data.desks.map((d) => d.desk), ['security', 'management']);
    const people = c.body.data.people;
    assert.ok(people.some((p) => p._id === id('r1')), 'r1 is listed in the directory');
    assert.ok(!people.some((p) => p._id === id('r3')), 'r3 never opted in');
    assert.ok(!people.some((p) => p.role === 'guard'));
    assert.ok(people.every((p) => !('phone' in p)));
    const g = await api.get('/api/v1/chat/contacts?search=r3').set(h('guard'));
    assert.equal(g.body.data.people.length, 1, 'guards can find any resident to reach them via the desk');
    assert.ok(!g.body.data.desks.some((d) => d.desk === 'security'));
  });
});
