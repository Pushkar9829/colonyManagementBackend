import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
const m = {};
const PASSWORD = 'Password@123';
const NEW_PASSWORD = 'NewPassw0rd!';

const IST = (d = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const plusDays = (n) => IST(Date.now() + n * 86400000);
const TODAY = IST();
const yearsAgo = (ymd, n) => `${Number(ymd.slice(0, 4)) - n}${ymd.slice(4)}`;
// 29 Feb only exists in leap years; keep test dates real.
const safe = (ymd, n) => (ymd.slice(5) === '02-29' ? `${Number(ymd.slice(0, 4)) - 4 * Math.ceil(n / 4)}-02-29` : yearsAgo(ymd, n));
const ok = (res, status = 200) => assert.equal(res.status, status, `${res.req?.method} ${res.req?.path}: ${JSON.stringify(res.body)}`);
const H = (who) => s[who];
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const v = await fn();
    if (v || Date.now() > end) return v;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 50));
  }
};

const login = async (identifier, password = PASSWORD) => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password });
  ok(res);
  return res.body.data;
};

async function inviteAndLogin(email, roleId) {
  const inv = await api.post('/api/v1/platform/team').set(s.owner).send({ name: email.split('@')[0], email, roleId });
  ok(inv, 201);
  const token = new URL(inv.body.data.inviteLink).searchParams.get('token');
  ok(await api.post('/api/v1/auth/password/reset').send({ token, password: NEW_PASSWORD }));
  return bearer((await login(email, NEW_PASSWORD)).accessToken);
}

async function society(key, name) {
  const reg = await api.post('/api/v1/auth/register-society').send({ society: { name }, admin: { name: `Admin ${name}`, email: `admin@${key}.test`, password: PASSWORD } });
  ok(reg, 201);
  s[`${key}Admin`] = bearer(reg.body.data.accessToken);
  s[`${key}Id`] = reg.body.data.user.society._id;
  const h = s[`${key}Admin`];
  const block = await api.post('/api/v1/blocks').set(h).send({ name: 'A' });
  ok(await api.post('/api/v1/units/bulk').set(h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 3, areaSqft: 900 }), 201);
  const units = (await api.get('/api/v1/units?limit=50').set(h)).body.data;
  s[`${key}Units`] = Object.fromEntries(units.map((u) => [u.label, u._id]));
}

async function member(key, soc, { email, phone, role = 'resident', unit, residentType = 'owner' }) {
  const body = { name: `${key} person`, email, phone, password: PASSWORD, role };
  if (unit) Object.assign(body, { unit: s[`${soc}Units`][unit], residentType });
  const res = await api.post('/api/v1/users').set(s[`${soc}Admin`]).send(body);
  ok(res, 201);
  const session = await login(email);
  s[key] = bearer(session.accessToken);
  s[`${key}Id`] = session.user._id;
}

before(async () => {
  api = await setup();
  for (const [k, p] of [
    ['User', '../src/modules/users/user.model.js'],
    ['Notification', '../src/modules/notifications/notification.model.js'],
    ['WhatsAppAccount', '../src/modules/whatsapp/whatsappAccount.model.js'],
    ['WhatsAppCredit', '../src/modules/whatsapp/whatsappCredit.model.js'],
    ['CelebrationWish', '../src/modules/celebrations/celebrationWish.model.js'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    m[k] = (await import(p)).default;
  }
  m.gate = await import('../src/modules/whatsapp/whatsapp.service.js');
  m.celebrations = await import('../src/modules/celebrations/celebrations.service.js');
  m.wa = (await import('../src/integrations/whatsapp.js')).whatsapp;

  await society('a', 'Lotus Court');
  await society('b', 'Banyan Heights');
  await member('r1', 'a', { email: 'r1@a.test', phone: '9711000001', unit: 'A-101' });
  await member('r2', 'a', { email: 'r2@a.test', phone: '9711000002', unit: 'A-102' });
  await member('t2', 'a', { email: 't2@a.test', phone: '9711000003', unit: 'A-102', residentType: 'tenant' });
  await member('guard', 'a', { email: 'guard@a.test', phone: '9711000004', role: 'guard' });
  await member('rb', 'b', { email: 'rb@b.test', phone: '9722000001', unit: 'A-101' });

  await m.User.create({ name: 'Owner', email: 'owner@platform.test', passwordHash: await m.User.hashPassword(PASSWORD), platformRole: 'super_admin' });
  s.owner = bearer((await login('owner@platform.test')).accessToken);
  const roles = (await api.get('/api/v1/platform/roles').set(s.owner)).body.data;
  s.billing = await inviteAndLogin('billing@platform.test', roles.find((r) => r.key === 'billing')._id);
  s.support = await inviteAndLogin('support@platform.test', roles.find((r) => r.key === 'support')._id);
});
after(teardown);

describe('personal details', () => {
  test('validation: future dates, impossible dates, anniversary before birth, occupation branches', async () => {
    const bad = async (body, field) => {
      const res = await api.put('/api/v1/people/me').set(H('r1')).send(body);
      assert.equal(res.status, 422, JSON.stringify(res.body));
      if (field) assert.ok(res.body.error.details.some((d) => d.field.startsWith(field)), JSON.stringify(res.body.error.details));
    };
    await bad({ dateOfBirth: plusDays(2) }, 'body.dateOfBirth');
    await bad({ dateOfBirth: '1990-02-30' }, 'body.dateOfBirth');
    await bad({ dateOfBirth: '1990-05-01', anniversaryDate: '1985-01-01' }, 'body.anniversaryDate');
    await bad({ gender: 'robot' }, 'body.gender');
    await bad({ occupation: { type: 'student' } }, 'body.occupation.student');
    await bad({ occupation: { type: 'working', working: { mode: 'job' } } }, 'body.occupation.working.category');
    await bad({ occupation: { type: 'working', working: { mode: 'freelance', category: 'it_software' } } });
  });

  test('a member saves their own details; switching occupation type drops the other branch', async () => {
    const student = { type: 'student', student: { institutionName: 'Delhi Public School, Pune', institutionType: 'school', course: 'Class 11', address: 'Mohammadwadi, Pune' } };
    let res = await api.put('/api/v1/people/me').set(H('r1')).send({ dateOfBirth: safe(TODAY, 17), gender: 'male', occupation: student });
    ok(res);
    assert.equal(res.body.data.occupation.student.institutionName, 'Delhi Public School, Pune');
    res = await api.put('/api/v1/people/me').set(H('r1')).send({ occupation: { type: 'working', student: student.student, working: { mode: 'job', category: 'healthcare', organisation: 'Ruby Hall' } } });
    ok(res);
    assert.equal(res.body.data.occupation.student, undefined);
    assert.equal(res.body.data.dateOfBirth, safe(TODAY, 17), 'a partial update keeps the other fields');
    ok(await api.put('/api/v1/people/me').set(H('r1')).send({ occupation: student }));
    res = await api.get('/api/v1/people/me').set(H('r1'));
    ok(res);
    assert.equal(res.body.data.occupation.type, 'student');
    // null clears
    ok(await api.put('/api/v1/people/me').set(H('t2')).send({ gender: 'female' }));
    res = await api.put('/api/v1/people/me').set(H('t2')).send({ gender: null });
    assert.equal(res.body.data.gender, null);
  });

  test('admins edit anyone in their society; residents and other societies cannot', async () => {
    const body = { anniversaryDate: safe(plusDays(3), 12), occupation: { type: 'working', working: { mode: 'job', category: 'it_software', organisation: 'Infosys', designation: 'Engineer', workAddress: 'Hinjewadi' } } };
    assert.equal((await api.put(`/api/v1/people/users/${s.r2Id}`).set(H('r1')).send(body)).status, 403);
    assert.equal((await api.put(`/api/v1/people/users/${s.r2Id}`).set(H('guard')).send(body)).status, 403);
    assert.equal((await api.put(`/api/v1/people/users/${s.r2Id}`).set(H('bAdmin')).send(body)).status, 404, 'other society: not found');
    const res = await api.put(`/api/v1/people/users/${s.r2Id}`).set(H('aAdmin')).send(body);
    ok(res);
    assert.equal(res.body.data.occupation.working.organisation, 'Infosys');
    ok(await api.put('/api/v1/people/me').set(H('r2')).send({ dateOfBirth: '1984-03-10' }));
    assert.equal((await api.get(`/api/v1/people/units/${s.aUnits['A-102']}`).set(H('r2'))).status, 403);
    assert.equal((await api.get(`/api/v1/people/units/${s.aUnits['A-102']}`).set(H('bAdmin'))).status, 404);
    const unit = await api.get(`/api/v1/people/units/${s.aUnits['A-102']}`).set(H('aAdmin'));
    ok(unit);
    assert.equal(unit.body.data.residents.length, 2);
    assert.equal(unit.body.data.residents.find((r) => String(r.user) === String(s.r2Id)).anniversaryDate, body.anniversaryDate);
  });

  test('family members carry the same fields; admins can edit them', async () => {
    let res = await api.post('/api/v1/household/me/members').set(H('r1')).send({
      name: 'Meera', relation: 'child', dob: safe(TODAY, 20), phone: '9711000099', gender: 'female', showBirthday: true,
      occupation: { type: 'student', student: { institutionName: 'COEP Pune', institutionType: 'college', course: 'B.Tech Mechanical' } },
    });
    ok(res, 201);
    const meera = res.body.data.members.find((x) => x.name === 'Meera');
    assert.equal(meera.occupation.student.institutionName, 'COEP Pune');
    s.meeraId = meera._id;
    res = await api.post('/api/v1/household/me/members').set(H('r1')).send({ name: 'Bad', relation: 'child', occupation: { type: 'working' } });
    assert.equal(res.status, 422);

    const path = `/api/v1/people/units/${s.aUnits['A-101']}/family/${s.meeraId}`;
    assert.equal((await api.put(path).set(H('r1')).send({ gender: 'other' })).status, 403);
    assert.equal((await api.put(`/api/v1/people/units/${s.bUnits['A-101']}/family/${s.meeraId}`).set(H('bAdmin')).send({ gender: 'other' })).status, 404);
    res = await api.put(path).set(H('aAdmin')).send({ occupation: { type: 'student', student: { institutionName: 'COEP Pune', institutionType: 'university', course: 'B.Tech' } } });
    ok(res);
    assert.equal(res.body.data.occupation.student.institutionType, 'university');
    assert.equal(res.body.data.dob, safe(TODAY, 20));
  });
});

describe('directory privacy and filters', () => {
  test('birthday shows day and month only when opted in; occupation only when opted in, never addresses', async () => {
    ok(await api.patch('/api/v1/directory/me').set(H('r1')).send({ listed: true }));
    ok(await api.patch('/api/v1/directory/me').set(H('r2')).send({ listed: true, showBirthday: true, showOccupation: true }));
    let list = (await api.get('/api/v1/directory').set(H('t2'))).body.data;
    const r1 = list.find((p) => String(p._id) === String(s.r1Id));
    assert.equal(r1.birthday, undefined);
    assert.equal(r1.occupation, undefined);
    const r2 = list.find((p) => String(p._id) === String(s.r2Id));
    assert.equal(r2.birthday, '03-10');
    assert.equal(r2.occupation.working.organisation, 'Infosys');
    assert.equal(r2.occupation.working.workAddress, undefined);
    const raw = JSON.stringify(list);
    assert.ok(!raw.includes('1984'), 'the birth year never leaves the server');
    assert.ok(!raw.includes('Hinjewadi'));

    ok(await api.patch('/api/v1/directory/me').set(H('r1')).send({ showBirthday: true, showOccupation: true }));
    list = (await api.get('/api/v1/directory').set(H('t2'))).body.data;
    const me = list.find((p) => String(p._id) === String(s.r1Id));
    assert.equal(me.birthday, TODAY.slice(5) === '02-29' ? '02-29' : TODAY.slice(5));
    assert.equal(me.occupation.student.institutionName, 'Delhi Public School, Pune');
    assert.equal(me.occupation.student.address, undefined);
    assert.ok(!JSON.stringify(list).includes(safe(TODAY, 17).slice(0, 4)));
    const mine = await api.get('/api/v1/directory/me').set(H('r1'));
    assert.equal(mine.body.data.showBirthday, true);
  });

  test('filter by occupation category, type and institution — only among people who show it', async () => {
    const ids = async (q) => (await api.get(`/api/v1/directory?${q}`).set(H('t2'))).body.data.map((p) => String(p._id));
    assert.deepEqual(await ids('occupationCategory=it_software'), [String(s.r2Id)]);
    assert.deepEqual(await ids('institution=delhi%20public'), [String(s.r1Id)]);
    assert.deepEqual(await ids('occupationType=student'), [String(s.r1Id)]);
    assert.deepEqual(await ids('search=infosys'), [String(s.r2Id)]);
    assert.equal((await api.get('/api/v1/directory?occupationCategory=astronaut').set(H('t2'))).status, 422);
    ok(await api.patch('/api/v1/directory/me').set(H('r2')).send({ showOccupation: false }));
    assert.deepEqual(await ids('occupationCategory=it_software'), []);
    assert.deepEqual(await ids('search=infosys'), [], 'hidden occupation is not searchable');
    ok(await api.patch('/api/v1/directory/me').set(H('r2')).send({ showOccupation: true }));
  });
});

describe('WhatsApp mode and credits (platform only)', () => {
  const base = () => `/api/v1/platform/societies/${s.aId}/whatsapp`;

  test('society admins and platform members without whatsapp.manage get 403', async () => {
    assert.equal((await api.get(base()).set(H('aAdmin'))).status, 403);
    assert.equal((await api.patch(base()).set(H('aAdmin')).send({ mode: 'api' })).status, 403);
    assert.equal((await api.post(`${base()}/credits`).set(H('aAdmin')).send({ amount: 100, note: 'free' })).status, 403);
    assert.equal((await api.patch(base()).set(H('support')).send({ mode: 'api' })).status, 403);
    ok(await api.get(base()).set(H('billing')));
    assert.equal((await api.patch(base()).set(H('owner')).send({})).status, 422);
    assert.equal((await api.post(`${base()}/credits`).set(H('owner')).send({ amount: 10 })).status, 422, 'a note is required');
    assert.equal((await api.patch('/api/v1/platform/societies/000000000000000000000000/whatsapp').set(H('owner')).send({ mode: 'api' })).status, 404);
  });

  test('defaults to off; off and click_to_chat never send automatically', async () => {
    assert.equal((await api.get('/api/v1/whatsapp').set(H('r1'))).body.data.mode, 'off');
    assert.equal(await m.gate.sendWhatsApp(s.aId, '9711000001', 'Hi', 'there', { kind: 'bill' }), 'off');
    ok(await api.patch(base()).set(H('billing')).send({ mode: 'click_to_chat' }));
    assert.equal(await m.gate.sendWhatsApp(s.aId, '9711000001', 'Hi', 'there', { kind: 'bill' }), 'click_to_chat');
    assert.equal(await m.gate.sendWhatsApp(s.aId, '9711000001', 'SOS', 'fire', { kind: 'sos', urgent: true }), 'click_to_chat');
    assert.equal(await m.WhatsAppCredit.countDocuments({ entry: { $ne: 'grant' } }), 0);
  });

  test('api mode debits one credit per message, refunds failures, stops at zero, SOS still goes out', async () => {
    ok(await api.patch(base()).set(H('owner')).send({ mode: 'api', lowBalanceThreshold: 1 }));
    let res = await api.post(`${base()}/credits`).set(H('owner')).send({ amount: 3, note: 'Starter pack' });
    ok(res, 201);
    assert.equal(res.body.data.balance, 3);

    const sent = [];
    const original = m.wa.sendAlert;
    m.wa.sendAlert = async (to) => { sent.push(to); };
    try {
      assert.equal(await m.gate.sendWhatsApp(s.aId, '9711000001', 'Bill', 'due', { kind: 'bill' }), 'sent');
      m.wa.sendAlert = async () => { throw new Error('provider down'); };
      assert.equal(await m.gate.sendWhatsApp(s.aId, '9711000001', 'Bill', 'due', { kind: 'bill' }), 'failed');
      let acc = await m.WhatsAppAccount.findOne({ society: s.aId }).lean();
      assert.equal(acc.balance, 2, 'failed send refunded');
      assert.equal(await m.WhatsAppCredit.countDocuments({ society: s.aId, entry: 'refund' }), 1);

      m.wa.sendAlert = async (to) => { sent.push(to); };
      assert.equal(await m.gate.sendWhatsApp(s.aId, '9711000002', 'Receipt', 'paid', { kind: 'receipt' }), 'sent');
      assert.equal(await m.gate.sendWhatsApp(s.aId, '9711000002', 'Wish', 'hb', { kind: 'wishes' }), 'sent');
      assert.equal(await m.gate.sendWhatsApp(s.aId, '9711000002', 'Reminder', 'due', { kind: 'reminder' }), 'no_credits');
      assert.equal(await m.gate.sendWhatsApp(s.aId, '9711000002', 'Reminder', 'due', { kind: 'reminder' }), 'no_credits');
      // SOS bypasses the zero balance and is still counted
      assert.equal(await m.gate.sendWhatsApp(s.aId, '9711000003', 'SOS', 'medical', { kind: 'sos', urgent: true }), 'sent');
      acc = await m.WhatsAppAccount.findOne({ society: s.aId }).lean();
      assert.equal(acc.balance, -1);
      assert.equal(sent.length, 4);
    } finally {
      m.wa.sendAlert = original;
    }

    const admins = async (title) => m.Notification.countDocuments({ society: s.aId, type: 'whatsapp_credits', title });
    assert.equal(await waitFor(async () => (await admins('WhatsApp credits used up')) === 1), true, 'admins told once');
    assert.equal(await admins('WhatsApp credits running low'), 1);

    // Through the notification channel: an SOS raised by a resident is charged as kind 'sos'.
    const original2 = m.wa.sendAlert;
    m.wa.sendAlert = async () => {};
    try {
      ok(await api.post('/api/v1/sos').set(H('r1')).send({ type: 'medical', message: 'Help' }), 201);
      const debited = await waitFor(() => m.WhatsAppCredit.countDocuments({ society: s.aId, entry: 'debit', kind: 'sos' }).then((n) => n >= 2));
      assert.equal(debited, true, 'SOS via notifications went through the gate');
    } finally {
      m.wa.sendAlert = original2;
    }
  });

  test('ledger totals, usage by kind, and the society admin card', async () => {
    const before = (await m.WhatsAppAccount.findOne({ society: s.aId }).lean()).balance;
    let res = await api.post(`${base()}/credits`).set(H('billing')).send({ amount: 100, note: 'Invoice INV-42' });
    ok(res, 201);
    assert.equal(res.body.data.balance, before + 100);
    assert.equal(res.body.data.low, false);
    const summary = (await api.get(base()).set(H('owner'))).body.data;
    const debits = await m.WhatsAppCredit.countDocuments({ society: s.aId, entry: 'debit' });
    assert.equal(summary.totals.granted, 103);
    assert.equal(summary.totals.debited, debits);
    assert.equal(summary.totals.refunded, 1);
    assert.equal(summary.balance, summary.totals.granted - summary.totals.debited + summary.totals.refunded);
    assert.equal(summary.usage.thisMonth, debits - 1);
    assert.equal(summary.usage.byKind.bill, 1, 'the refunded bill message is not counted');
    assert.equal(summary.usage.byKind.receipt, 1);
    assert.equal(summary.usage.byKind.wishes, 1);
    assert.ok(summary.usage.byKind.sos >= 2);
    const acc = await m.WhatsAppAccount.findOne({ society: s.aId }).lean();
    assert.equal(acc.emptyNotifiedAt, undefined, 'top-up re-arms the warnings');

    const ledger = await api.get(`${base()}/ledger?entry=grant`).set(H('owner'));
    ok(ledger);
    assert.equal(ledger.body.meta.total, 2);
    assert.equal(ledger.body.data[0].note, 'Invoice INV-42');

    const card = (await api.get('/api/v1/whatsapp').set(H('aAdmin'))).body.data;
    assert.equal(card.mode, 'api');
    assert.equal(card.balance, summary.balance);
    assert.equal(card.usage.thisMonth, summary.usage.thisMonth);
    const residentView = (await api.get('/api/v1/whatsapp').set(H('r1'))).body.data;
    assert.deepEqual(Object.keys(residentView), ['mode'], 'residents only learn the mode');
  });

  test('cross-society isolation', async () => {
    const b = (await api.get('/api/v1/whatsapp').set(H('bAdmin'))).body.data;
    assert.equal(b.mode, 'off');
    assert.equal(b.balance, 0);
    assert.equal(b.usage.thisMonth, 0);
    assert.equal(await m.gate.sendWhatsApp(s.bId, '9722000001', 'Hi', 'x', { kind: 'bill' }), 'off');
    const bSummary = (await api.get(`/api/v1/platform/societies/${s.bId}/whatsapp`).set(H('owner'))).body.data;
    assert.equal(bSummary.totals.granted, 0);
    assert.equal(bSummary.recent.length, 0);
  });
});

describe('celebrations', () => {
  const at = (hhmm) => new Date(`${TODAY}T${hhmm}:00+05:30`);

  test('settings: admin only, validated, preview with placeholders and Hindi', async () => {
    assert.equal((await api.get('/api/v1/celebrations/settings').set(H('r1'))).status, 403);
    let res = await api.get('/api/v1/celebrations/settings').set(H('aAdmin'));
    ok(res);
    assert.equal(res.body.data.enabled, true);
    assert.equal(res.body.data.sendTime, '08:00');
    assert.ok(res.body.data.defaults.hi.birthday.includes('{name}'));
    assert.equal((await api.put('/api/v1/celebrations/settings').set(H('aAdmin')).send({ sendTime: '25:00' })).status, 422);
    res = await api.post('/api/v1/celebrations/preview').set(H('aAdmin')).send({ kind: 'anniversary', template: 'Hi {name}, {years} years! — {society}' });
    ok(res);
    assert.equal(res.body.data.message, 'Hi Ravi Iyer, 12 years! — Lotus Court');
    res = await api.post('/api/v1/celebrations/preview').set(H('aAdmin')).send({ kind: 'birthday', language: 'hi' });
    assert.ok(res.body.data.message.includes('Lotus Court'));
    assert.ok(res.body.data.message.includes('जन्मदिन'));
  });

  test('upcoming list (next 30 days) for admins, with prepared messages', async () => {
    assert.equal((await api.get('/api/v1/celebrations/upcoming').set(H('r1'))).status, 403);
    const res = await api.get('/api/v1/celebrations/upcoming').set(H('aAdmin'));
    ok(res);
    const items = res.body.data.items;
    const birthday = items.find((i) => i.kind === 'birthday' && i.name === 'r1 person');
    assert.equal(birthday.daysAway, 0);
    assert.equal(birthday.years, 17);
    const anniversary = items.find((i) => i.kind === 'anniversary' && i.name === 'r2 person');
    assert.equal(anniversary.daysAway, 3);
    assert.ok(anniversary.message.includes('12'));
    assert.ok(items.some((i) => i.name === 'Meera' && i.subject === 'family'));
    assert.ok(!items.some((i) => i.name === 'rb person'), 'other society never listed');
    assert.equal(res.body.data.whatsappMode, 'api');
  });

  test("today's birthdays card shows only opted-in people, without dates", async () => {
    const res = await api.get('/api/v1/celebrations/today').set(H('t2'));
    ok(res);
    const names = res.body.data.people.map((p) => p.name).sort();
    assert.deepEqual(names, ['Meera', 'r1 person']);
    assert.ok(!JSON.stringify(res.body.data).includes(safe(TODAY, 17).slice(0, 4)));
    ok(await api.patch('/api/v1/directory/me').set(H('r1')).send({ showBirthday: false }));
    assert.deepEqual((await api.get('/api/v1/celebrations/today').set(H('t2'))).body.data.people.map((p) => p.name), ['Meera']);
    ok(await api.patch('/api/v1/directory/me').set(H('r1')).send({ showBirthday: true }));
  });

  test('daily job respects the on/off switch and the send time', async () => {
    ok(await api.put('/api/v1/celebrations/settings').set(H('aAdmin')).send({ enabled: false }));
    assert.equal((await m.celebrations.sendDueWishes(at('09:00'))).sent, 0);
    ok(await api.put('/api/v1/celebrations/settings').set(H('aAdmin')).send({ enabled: true, sendTime: '10:30' }));
    assert.equal((await m.celebrations.sendDueWishes(at('09:00'))).sent, 0, 'before the send time');
    assert.equal(await m.CelebrationWish.countDocuments(), 0);
  });

  test('wishes go out once per person per day, through in-app and the WhatsApp gate', async () => {
    // Someone in society B with a birthday today: B's own settings/mode apply, never A's.
    ok(await api.put('/api/v1/people/me').set(H('rb')).send({ dateOfBirth: safe(TODAY, 30) }));
    ok(await api.put('/api/v1/celebrations/settings').set(H('aAdmin')).send({ sendTime: '08:00', templates: { birthday: 'Happy birthday {name} from {society}' } }));
    const balance = (await m.WhatsAppAccount.findOne({ society: s.aId }).lean()).balance;
    const sent = [];
    const original = m.wa.sendAlert;
    m.wa.sendAlert = async (to, title, body) => { sent.push({ to, title, body }); };
    try {
      const first = await m.celebrations.sendDueWishes(at('09:00'));
      assert.equal(first.sent, 3, 'r1 birthday, Meera birthday, rb birthday');
      const again = await m.celebrations.sendDueWishes(at('11:00'));
      assert.equal(again.sent, 0, 'idempotent');
      await Promise.all([m.celebrations.sendDueWishes(at('12:00')), m.celebrations.sendDueWishes(at('12:00'))]);
      assert.equal(await m.CelebrationWish.countDocuments(), 3);
    } finally {
      m.wa.sendAlert = original;
    }
    // Society A is in api mode: r1 and Meera got WhatsApp; society B is off: rb did not.
    assert.deepEqual(sent.map((x) => x.to).sort(), ['9711000001', '9711000099']);
    assert.ok(sent.find((x) => x.to === '9711000001').body.startsWith('Happy birthday r1 person from Lotus Court'));
    assert.equal((await m.WhatsAppAccount.findOne({ society: s.aId }).lean()).balance, balance - 2);
    assert.equal(await m.WhatsAppCredit.countDocuments({ society: s.aId, kind: 'wishes', entry: 'debit' }), 3);

    const notes = (await api.get('/api/v1/notifications?limit=50').set(H('r1'))).body.data.filter((n) => n.type === 'celebration');
    assert.equal(notes.length, 2, 'r1 gets their own wish plus the household note about Meera');
    const rbNotes = (await api.get('/api/v1/notifications?limit=50').set(H('rb'))).body.data.filter((n) => n.type === 'celebration');
    assert.equal(rbNotes.length, 1);
    const r1Wish = await m.CelebrationWish.findOne({ personKey: `user:${s.r1Id}` }).lean();
    assert.ok(r1Wish.channels.includes('whatsapp:sent'));

    const upcoming = (await api.get('/api/v1/celebrations/upcoming').set(H('aAdmin'))).body.data.items;
    assert.equal(upcoming.find((i) => i.kind === 'birthday' && i.name === 'r1 person').wished, true);
  });
});
