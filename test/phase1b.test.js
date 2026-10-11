import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};

// 1x1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

before(async () => {
  api = await setup();
  const reg = await api.post('/api/v1/auth/register-society').send({
    society: { name: 'Lake View' },
    admin: { name: 'Admin Lake', email: 'admin@lv.test', password: 'Password@123' },
  });
  s.admin = reg.body.data;
  const h = bearer(s.admin.accessToken);
  const block = await api.post('/api/v1/blocks').set(h).send({ name: 'C' });
  await api.post('/api/v1/units/bulk').set(h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 2, areaSqft: 500 });
  const units = await api.get('/api/v1/units').set(h);
  s.unit = units.body.data[0]._id;
  for (const [email, phone] of [['r1@lv.test', '9811111111'], ['r2@lv.test', '9822222222']]) {
    // eslint-disable-next-line no-await-in-loop
    await api.post('/api/v1/users').set(h).send({ name: email, email, phone, password: 'Password@123', role: 'resident', unit: units.body.data[email === 'r1@lv.test' ? 0 : 1]._id, residentType: 'owner' });
  }
  await api.post('/api/v1/users').set(h).send({ name: 'Guard', email: 'g@lv.test', password: 'Password@123', role: 'guard' });
  const login = async (identifier) => (await api.post('/api/v1/auth/login').send({ identifier, password: 'Password@123' })).body.data;
  s.r1 = await login('r1@lv.test');
  s.r2 = await login('r2@lv.test');
  s.guard = await login('g@lv.test');
});
after(teardown);

describe('OTP login', () => {
  test('request, wrong code, right code, single use', async () => {
    const req = await api.post('/api/v1/auth/otp/request').send({ phone: '9811111111' });
    assert.equal(req.status, 200);
    assert.match(req.body.data.devCode, /^\d{6}$/);
    const cooldown = await api.post('/api/v1/auth/otp/request').send({ phone: '9811111111' });
    assert.equal(cooldown.status, 429);

    const wrong = await api.post('/api/v1/auth/otp/verify').send({ phone: '9811111111', code: req.body.data.devCode === '000000' ? '111111' : '000000' });
    assert.equal(wrong.status, 401);
    const ok = await api.post('/api/v1/auth/otp/verify').send({ phone: '9811111111', code: req.body.data.devCode });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.user.email, 'r1@lv.test');
    const reuse = await api.post('/api/v1/auth/otp/verify').send({ phone: '9811111111', code: req.body.data.devCode });
    assert.equal(reuse.status, 401);
  });

  test('unknown numbers get the same answer and no code', async () => {
    const res = await api.post('/api/v1/auth/otp/request').send({ phone: '9899999999' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.devCode, undefined);
  });

  test('locks after 5 wrong attempts', async () => {
    const req = await api.post('/api/v1/auth/otp/request').send({ phone: '9822222222' });
    const bad = req.body.data.devCode === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await api.post('/api/v1/auth/otp/verify').send({ phone: '9822222222', code: bad });
    }
    const locked = await api.post('/api/v1/auth/otp/verify').send({ phone: '9822222222', code: req.body.data.devCode });
    assert.equal(locked.status, 429);
  });
});

describe('uploads & attachments', () => {
  test('uploads an image and attaches it to a complaint', async () => {
    const up = await api.post('/api/v1/uploads').set(bearer(s.r1.accessToken)).field('folder', 'complaints').attach('file', PNG, 'leak.png');
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.data.mimetype, 'image/png');
    const file = await api.get(new URL(up.body.data.url).pathname);
    assert.equal(file.status, 200);
    assert.equal(file.headers['cross-origin-resource-policy'], 'cross-origin');

    const c = await api.post('/api/v1/complaints').set(bearer(s.r1.accessToken)).send({ category: 'plumbing', title: 'Leak in bathroom', attachments: [up.body.data._id] });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.data.attachments.length, 1);

    // another resident can't reuse someone else's upload
    const steal = await api.post('/api/v1/complaints').set(bearer(s.r2.accessToken)).send({ category: 'plumbing', title: 'Not mine', attachments: [up.body.data._id] });
    assert.equal(steal.status, 400);
  });

  test('rejects files whose content is not an allowed type', async () => {
    const fake = await api.post('/api/v1/uploads').set(bearer(s.r1.accessToken)).field('folder', 'complaints').attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' });
    assert.equal(fake.status, 400);
  });
});

describe('amenity booking race', () => {
  test('two simultaneous bookings for the last slot: exactly one wins', async () => {
    const hall = await api.post('/api/v1/amenities').set(bearer(s.admin.accessToken)).send({ name: 'Hall', capacity: 1, openTime: '09:00', closeTime: '18:00', slotMinutes: 60 });
    const date = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const body = { amenity: hall.body.data._id, date, startTime: '10:00', endTime: '11:00' };
    const results = await Promise.all([
      api.post('/api/v1/bookings').set(bearer(s.r1.accessToken)).send(body),
      api.post('/api/v1/bookings').set(bearer(s.r2.accessToken)).send(body),
    ]);
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [201, 409]);
  });
});

describe('scheduled jobs', () => {
  test('SLA escalation notifies managers once', async () => {
    const { default: Complaint } = await import('../src/modules/complaints/complaint.model.js');
    const { slaEscalations } = await import('../src/jobs/jobs.js');
    const c = await api.post('/api/v1/complaints').set(bearer(s.r1.accessToken)).send({ category: 'lift', priority: 'urgent', title: 'Lift stuck on 3rd floor' });
    await Complaint.updateOne({ _id: c.body.data._id }, { slaDueAt: new Date(Date.now() - 60000) });
    const first = await slaEscalations();
    assert.equal(first.escalated, 1);
    const second = await slaEscalations();
    assert.equal(second.escalated, 0);
    const notes = await api.get('/api/v1/notifications').set(bearer(s.admin.accessToken));
    assert.ok(notes.body.data.some((n) => n.title.startsWith('SLA breached')));
  });

  test('dues reminders and auto-billing', async () => {
    const { autoGenerateBills, duesReminders } = await import('../src/jobs/jobs.js');
    await api.patch('/api/v1/society/me/settings').set(bearer(s.admin.accessToken)).send({ billing: { fixedAmount: 100000, autoGenerate: true, generateDay: 1, dueDays: 2 } });
    const gen = await autoGenerateBills();
    assert.equal(gen.created, 2);
    const again = await autoGenerateBills();
    assert.equal(again.created, 0, 'never bills a month twice');
    const rem = await duesReminders();
    assert.equal(rem.reminded, 2, 'due within 3 days');
    const rem2 = await duesReminders();
    assert.equal(rem2.reminded, 0, 'not reminded again the same day');
  });

  test('scheduler lock lets only one runner claim a job', async () => {
    const { runJob } = await import('../src/jobs/scheduler.js');
    let calls = 0;
    await runJob({ name: 'test-job', everyMs: 1000, run: async () => { calls += 1; return { ok: 1 }; } });
    const { default: JobLock } = await import('../src/jobs/jobLock.model.js');
    const lock = await JobLock.findById('test-job').lean();
    assert.equal(calls, 1);
    assert.ok(lock.lastRunAt);
  });
});

describe('push subscriptions', () => {
  test('config endpoint and subscribe/unsubscribe', async () => {
    const h = bearer(s.r1.accessToken);
    const cfg = await api.get('/api/v1/notifications/push/config').set(h);
    assert.equal(cfg.status, 200);
    const sub = { endpoint: 'https://push.example.com/abc123', keys: { p256dh: 'BOrandomkeyrandomkey', auth: 'authsecret' } };
    assert.equal((await api.post('/api/v1/notifications/push/subscribe').set(h).send(sub)).status, 200);
    assert.equal((await api.post('/api/v1/notifications/push/unsubscribe').set(h).send({ endpoint: sub.endpoint })).status, 200);
  });
});
