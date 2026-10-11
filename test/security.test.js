import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
const PW = 'Password@123';

const login = async (identifier) => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password: PW });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const h = (who) => bearer(s[who].accessToken);
const notes = async (who) => (await api.get('/api/v1/notifications?limit=100').set(h(who))).body.data;
const device = (key) => ({ 'X-Device-Key': key });

let models;
let gateTime;
let settingsLookup;

before(async () => {
  api = await setup();
  models = {
    Visitor: (await import('../src/modules/visitors/visitor.model.js')).default,
    Parcel: (await import('../src/modules/parcels/parcel.model.js')).default,
    BarrierCommand: (await import('../src/modules/gateDevices/barrierCommand.model.js')).default,
    ...(await import('../src/modules/parking/parking.model.js')),
    ...(await import('../src/modules/emergency/emergency.model.js')),
    ...(await import('../src/modules/patrols/patrol.model.js')),
    Types: (await import('mongoose')).default.Types,
  };
  gateTime = await import('../src/modules/visitors/gateTime.js');
  ({ settingsLookup } = await import('../src/modules/visitors/securitySettings.service.js'));

  const reg = await api.post('/api/v1/auth/register-society').send({
    society: { name: 'Sentinel Heights' },
    admin: { name: 'Admin Sentinel', email: 'admin@sh.test', password: PW },
  });
  s.admin = reg.body.data;
  const block = await api.post('/api/v1/blocks').set(h('admin')).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(h('admin')).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 2, areaSqft: 900 });
  const units = (await api.get('/api/v1/units').set(h('admin'))).body.data;
  s.u101 = units.find((u) => u.label === 'A-101')._id;
  s.u102 = units.find((u) => u.label === 'A-102')._id;

  const people = [
    ['r1', 'resident', '9800000001', s.u101, 'owner'],
    ['r1b', 'resident', '9800000002', s.u101, 'family'],
    ['r2', 'resident', '9800000003', s.u102, 'owner'],
    ['guard', 'guard', '9800000004'],
    ['guard2', 'guard', '9800000005'],
    ['fm', 'facility_manager', '9800000006'],
  ];
  for (const [key, role, phone, unit, residentType] of people) {
    const body = { name: `${key} user`, email: `${key}@sh.test`, phone, password: PW, role };
    if (unit) Object.assign(body, { unit, residentType });
    // eslint-disable-next-line no-await-in-loop
    const res = await api.post('/api/v1/users').set(h('admin')).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // eslint-disable-next-line no-await-in-loop
    s[key] = await login(`${key}@sh.test`);
  }

  // A second society for isolation checks.
  const other = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Other Towers' }, admin: { name: 'Other Admin', email: 'admin@ot.test', password: PW } });
  s.other = other.body.data;
  await api.post('/api/v1/users').set(h('other')).send({ name: 'Other guard', email: 'guard@ot.test', password: PW, role: 'guard' });
  s.otherGuard = await login('guard@ot.test');
});
after(teardown);

describe('blocklist / watchlist', () => {
  test('managers maintain the list, guards can view, residents cannot', async () => {
    const block = await api.post('/api/v1/visitors/watchlist').set(h('fm')).send({ type: 'block', name: 'Rogue Seller', phone: '9911122233', reason: 'Harassed residents' });
    assert.equal(block.status, 201, JSON.stringify(block.body));
    assert.equal(block.body.data.phoneKey, '9911122233');
    s.blockEntry = block.body.data._id;
    const watch = await api.post('/api/v1/visitors/watchlist').set(h('fm')).send({ type: 'watch', vehicleNumber: 'KA 01 ZZ 9999', reason: 'Seen loitering at night' });
    assert.equal(watch.status, 201);
    assert.equal(watch.body.data.vehicleNumber, 'KA01ZZ9999');
    const expired = await api.post('/api/v1/visitors/watchlist').set(h('fm')).send({ type: 'block', phone: '9922233344', reason: 'Old ban', expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(expired.status, 201);

    assert.equal((await api.get('/api/v1/visitors/watchlist').set(h('guard'))).body.meta.total, 3);
    assert.equal((await api.get('/api/v1/visitors/watchlist?active=true').set(h('guard'))).body.meta.total, 2);
    assert.equal((await api.post('/api/v1/visitors/watchlist').set(h('guard')).send({ type: 'block', name: 'X Person', reason: 'nope' })).status, 403);
    assert.equal((await api.get('/api/v1/visitors/watchlist').set(h('r1'))).status, 403);
    const invalid = await api.post('/api/v1/visitors/watchlist').set(h('fm')).send({ type: 'block', reason: 'nothing to match' });
    assert.equal(invalid.status, 422);
    const check = await api.post('/api/v1/visitors/watchlist/check').set(h('guard')).send({ phone: '+91 99111 22233' });
    assert.equal(check.body.data.status, 'block');
  });

  test('blocked visitor is refused at entry, recorded, and management alerted', async () => {
    const res = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Rogue Seller', phone: '9911122233', purpose: 'other' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'VISITOR_BLOCKED');
    assert.match(res.body.error.message, /blocklist/);
    const flagged = await api.get('/api/v1/visitors?flagged=true').set(h('fm'));
    const rec = flagged.body.data.find((v) => v.flag?.type === 'block');
    assert.equal(rec.status, 'denied');
    assert.ok((await notes('fm')).some((n) => n.type === 'security' && /Blocked at gate/.test(n.title)));
    assert.ok((await notes('admin')).some((n) => n.type === 'security'));
    // household is not asked to approve a blocked person
    assert.ok(!(await notes('r1')).some((n) => /Rogue Seller/.test(n.title)));
    // an expired ban does not block
    const old = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Reformed Guy', phone: '9922233344' });
    assert.equal(old.status, 201);
  });

  test('watch-listed vehicle is allowed but flagged and guards alerted', async () => {
    const res = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u102, name: 'Driver Dan', vehicleNumber: 'ka01zz9999', purpose: 'guest' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'pending');
    assert.equal(res.body.data.flag.type, 'watch');
    assert.equal(res.body.data.watch.reason, 'Seen loitering at night');
    assert.ok((await notes('guard2')).some((n) => n.type === 'security' && /Watchlist/.test(n.title)));
    assert.ok((await notes('fm')).some((n) => /Watchlist/.test(n.title)));
  });

  test('blocked guest cannot use a pre-approved pass', async () => {
    const now = Date.now();
    const pass = await api.post('/api/v1/visitors/passes').set(h('r1')).send({ guestName: 'Rogue Seller', phone: '9911122233', validFrom: new Date(now - 60000).toISOString(), validTo: new Date(now + 3600000).toISOString() });
    assert.equal(pass.status, 201);
    const use = await api.post('/api/v1/visitors/passes/verify').set(h('guard')).send({ code: pass.body.data.code });
    assert.equal(use.status, 403);
    assert.equal(use.body.error.code, 'VISITOR_BLOCKED');
    // the refusal did not consume the pass
    const passes = await api.get('/api/v1/visitors/passes').set(h('r1'));
    assert.equal(passes.body.data.find((p) => p._id === pass.body.data._id).usedCount, 0);
  });
});

describe('guest passes: QR, recurring, frequent visitors', () => {
  test('pass carries a signed QR token that guards can scan; forged tokens fail', async () => {
    const now = Date.now();
    const pass = await api.post('/api/v1/visitors/passes').set(h('r1')).send({ guestName: 'Cousin Kiran', validFrom: new Date(now - 60000).toISOString(), validTo: new Date(now + 3600000).toISOString() });
    assert.match(pass.body.data.qrToken, /^CHP1\.[a-f0-9]{24}\./);
    const forged = `${pass.body.data.qrToken.slice(0, -3)}abc`;
    assert.equal((await api.post('/api/v1/visitors/passes/verify').set(h('guard')).send({ qr: forged })).status, 404);
    const garbage = await api.post('/api/v1/visitors/passes/verify').set(h('guard')).send({ qr: 'https://evil.example/x' });
    assert.equal(garbage.status, 400);
    const ok = await api.post('/api/v1/visitors/passes/verify').set(h('guard')).send({ qr: pass.body.data.qrToken });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, 'checked_in');
    // guards' pass list never contains QR tokens
    const guardList = await api.get('/api/v1/visitors/passes').set(h('guard'));
    assert.ok(guardList.body.data.every((p) => !p.qrToken));
    // another society cannot use this QR
    const other = await api.post('/api/v1/visitors/passes/verify').set(bearer(s.otherGuard.accessToken)).send({ qr: pass.body.data.qrToken });
    assert.equal(other.status, 404);
  });

  test('recurring pass works only inside its weekly window and is reusable', async () => {
    const { localDateString } = await import('../src/common/utils/dates.js');
    const yesterday = localDateString(new Date(Date.now() - 86400000));
    const dayBefore = localDateString(new Date(Date.now() - 2 * 86400000));
    const dow = gateTime.localParts(gateTime.localDateTime(yesterday, '12:00')).dow;
    const at = (d, t) => gateTime.localDateTime(d, t).toISOString();

    const bad = await api.post('/api/v1/visitors/passes').set(h('r1')).send({ guestName: 'Tutor Meera', validFrom: new Date(Date.now() - 3 * 86400000).toISOString(), validTo: new Date(Date.now() + 60 * 86400000).toISOString(), recurrence: { days: [dow], startTime: '19:00', endTime: '17:00' } });
    assert.equal(bad.status, 422);
    const pass = await api.post('/api/v1/visitors/passes').set(h('r1')).send({
      guestName: 'Tutor Meera',
      phone: '9833344455',
      validFrom: new Date(Date.now() - 3 * 86400000).toISOString(),
      validTo: new Date(Date.now() + 60 * 86400000).toISOString(),
      recurrence: { days: [dow], startTime: '17:00', endTime: '19:00' },
    });
    assert.equal(pass.status, 201, JSON.stringify(pass.body));
    assert.equal(pass.body.data.kind, 'recurring');
    const code = pass.body.data.code;
    const g = h('guard');

    const outside = await api.post('/api/v1/visitors/passes/verify').set(g).send({ code, occurredAt: at(yesterday, '20:00') });
    assert.equal(outside.status, 400);
    assert.match(outside.body.error.message, /time window/);
    const wrongDay = await api.post('/api/v1/visitors/passes/verify').set(g).send({ code, occurredAt: at(dayBefore, '18:00') });
    assert.equal(wrongDay.status, 400);

    const inside = await api.post('/api/v1/visitors/passes/verify').set(g).send({ code, occurredAt: at(yesterday, '18:00') });
    assert.equal(inside.status, 201, JSON.stringify(inside.body));
    assert.equal(new Date(inside.body.data.checkInAt).toISOString(), at(yesterday, '18:00'));
    const again = await api.post('/api/v1/visitors/passes/verify').set(g).send({ code, occurredAt: at(yesterday, '18:10') });
    assert.equal(again.status, 409);
    await api.post(`/api/v1/visitors/${inside.body.data._id}/check-out`).set(g).send({ occurredAt: at(yesterday, '18:30') });
    const reuse = await api.post('/api/v1/visitors/passes/verify').set(g).send({ code, occurredAt: at(yesterday, '18:45') });
    assert.equal(reuse.status, 201);
    const list = await api.get('/api/v1/visitors/passes?kind=recurring').set(h('r1'));
    assert.equal(list.body.data[0].status, 'active');
    assert.equal(list.body.data[0].usedCount, 2);
  });

  test('weekly window helper respects IST day and minutes', () => {
    // 2026-10-12 is a Monday
    const mon1730 = gateTime.localDateTime('2026-10-12', '17:30');
    const mon1900 = gateTime.localDateTime('2026-10-12', '19:00');
    const tue1730 = gateTime.localDateTime('2026-10-13', '17:30');
    const win = { days: [1, 3], startTime: '17:00', endTime: '19:00' };
    assert.equal(gateTime.inWeeklyWindow(mon1730, win), true);
    assert.equal(gateTime.inWeeklyWindow(mon1900, win), false);
    assert.equal(gateTime.inWeeklyWindow(tue1730, win), false);
  });

  test('frequent visitor with auto-approve skips the approval request; one-tap pass', async () => {
    const noPhone = await api.post('/api/v1/visitors/frequent').set(h('r1')).send({ name: 'Uncle Raj', autoApprove: true });
    assert.equal(noPhone.status, 400);
    const fv = await api.post('/api/v1/visitors/frequent').set(h('r1')).send({ name: 'Uncle Raj', phone: '9844455566', autoApprove: true });
    assert.equal(fv.status, 201, JSON.stringify(fv.body));
    const dup = await api.post('/api/v1/visitors/frequent').set(h('r1')).send({ name: 'Raj', phone: '+919844455566' });
    assert.equal(dup.status, 409);

    const entry = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Raj', phone: '9844455566' });
    assert.equal(entry.status, 201);
    assert.equal(entry.body.data.status, 'checked_in');
    assert.equal(entry.body.data.autoApproved, true);
    // same phone for a different flat is not auto-approved
    const otherUnit = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u102, name: 'Raj', phone: '9844455566' });
    assert.equal(otherUnit.body.data.status, 'pending');

    const pass = await api.post(`/api/v1/visitors/frequent/${fv.body.data._id}/pass`).set(h('r1')).send({ hours: 4 });
    assert.equal(pass.status, 201);
    assert.match(pass.body.data.code, /^\d{6}$/);
    const list = await api.get(`/api/v1/visitors/frequent?unit=${s.u101}`).set(h('guard'));
    assert.equal(list.body.data[0].visits, 1);
    assert.equal((await api.post(`/api/v1/visitors/frequent/${fv.body.data._id}/pass`).set(h('r2')).send({})).status, 404);
  });
});

describe('offline gate sync', () => {
  test('same key twice creates one entry and occurredAt is honoured', async () => {
    const inAt = new Date(Date.now() - 10 * 60000).toISOString();
    const outAt = new Date(Date.now() - 4 * 60000).toISOString();
    const ops = [
      { key: 'gate1-0001-entry', kind: 'entry', occurredAt: inAt, data: { unit: s.u102, name: 'Offline Olga', purpose: 'guest', guardApproved: true } },
      { key: 'gate1-0002-out', kind: 'checkout', occurredAt: outAt, data: { entryKey: 'gate1-0001-entry' } },
    ];
    const first = await api.post('/api/v1/visitors/sync').set(h('guard')).send({ ops });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.data.results.map((r) => r.status), ['ok', 'ok']);
    const second = await api.post('/api/v1/visitors/sync').set(h('guard')).send({ ops });
    assert.equal(second.body.data.summary.duplicates, 2);

    const rows = await models.Visitor.find({ clientKey: 'gate1-0001-entry' }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'checked_out');
    assert.equal(rows[0].offline, true);
    assert.equal(rows[0].checkInAt.toISOString(), inAt);
    assert.equal(rows[0].occurredAt.toISOString(), inAt);
    assert.equal(rows[0].checkOutAt.toISOString(), outAt);
  });

  test('direct entry with the same clientKey returns the original', async () => {
    const body = { unit: s.u101, name: 'Retry Ravi', clientKey: 'gate1-direct-0003', occurredAt: new Date(Date.now() - 60000).toISOString() };
    const a = await api.post('/api/v1/visitors').set(h('guard')).send(body);
    const b = await api.post('/api/v1/visitors').set(h('guard')).send(body);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(a.body.data._id, b.body.data._id);
    assert.equal(b.body.data.duplicate, true);
  });

  test('conflicts are reported per op and kept on retry', async () => {
    const visitor = (await models.Visitor.findOne({ clientKey: 'gate1-0001-entry' }).lean())._id;
    const ops = [
      { key: 'gate1-0004-out', kind: 'checkout', occurredAt: new Date().toISOString(), data: { visitorId: String(visitor) } },
      { key: 'gate1-0005-entry', kind: 'entry', occurredAt: new Date().toISOString(), data: { unit: s.u101, name: 'Rogue Seller', phone: '9911122233' } },
      { key: 'gate1-0006-entry', kind: 'entry', occurredAt: new Date(Date.now() - 9 * 86400000).toISOString(), data: { unit: s.u101, name: 'Too Old' } },
      { key: 'gate1-0007-bad', kind: 'entry', occurredAt: new Date().toISOString(), data: { name: 'No unit' } },
    ];
    const res = await api.post('/api/v1/visitors/sync').set(h('guard')).send({ ops });
    const [out, blocked, old, invalid] = res.body.data.results;
    assert.equal(out.status, 'conflict');
    assert.match(out.message, /Already checked out/);
    assert.equal(blocked.status, 'conflict');
    assert.equal(blocked.code, 'VISITOR_BLOCKED');
    assert.equal(old.status, 'conflict');
    assert.equal(invalid.status, 'conflict');
    const retry = await api.post('/api/v1/visitors/sync').set(h('guard')).send({ ops: [ops[1]] });
    assert.equal(retry.body.data.results[0].status, 'conflict');
    assert.equal(retry.body.data.results[0].duplicate, true);
    assert.equal((await api.post('/api/v1/visitors/sync').set(h('r1')).send({ ops })).status, 403);
  });
});

describe('approval escalation (IVR fallback)', () => {
  test('unanswered visitor re-alerts the household and asks the guard to call', async () => {
    const { escalatePending } = await import('../src/modules/visitors/visitors.service.js');
    const entry = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Waiting Wanda' });
    await models.Visitor.collection.updateOne({ _id: new models.Types.ObjectId(entry.body.data._id) }, { $set: { createdAt: new Date(Date.now() - 120000) } });
    const r = await escalatePending(settingsLookup);
    assert.ok(r.escalated >= 1);
    const v = await models.Visitor.findById(entry.body.data._id).lean();
    assert.equal(v.callResident, true);
    assert.ok((await notes('r1b')).some((n) => /still waiting/.test(n.title)));
    assert.ok((await notes('guard')).some((n) => /Call resident: A-101/.test(n.title)));
    assert.equal((await escalatePending(settingsLookup)).escalated, 0);
    const contacts = await api.get(`/api/v1/visitors/${entry.body.data._id}/contacts`).set(h('guard'));
    assert.equal(contacts.body.data.length, 2);
    assert.ok(contacts.body.data.some((c) => c.phone === '9800000002'));
    const approved = await api.post(`/api/v1/visitors/${entry.body.data._id}/approve`).set(h('r1b')).send({});
    assert.equal(approved.body.data.callResident, false);
  });
});

describe('parcels', () => {
  test('lifecycle: logged, resident sees OTP, wrong OTP rejected, collected once', async () => {
    const p = await api.post('/api/v1/parcels').set(h('guard')).send({ unit: s.u101, courier: 'Amazon', trackingNo: 'AMZ123', storageLocation: 'Shelf 2' });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.data.status, 'notified');
    assert.match(p.body.data.number, /^PCL-\d{6}$/);
    assert.equal(p.body.data.otp, undefined);
    s.parcel = p.body.data._id;
    assert.ok((await notes('r1')).some((n) => n.type === 'parcel'));

    const mine = await api.get('/api/v1/parcels').set(h('r1'));
    const otp = mine.body.data.find((x) => x._id === s.parcel).otp;
    assert.match(otp, /^\d{4}$/);
    assert.equal((await api.get('/api/v1/parcels').set(h('r2'))).body.meta.total, 0);
    assert.ok((await api.get('/api/v1/parcels?open=true').set(h('guard'))).body.data.every((x) => x.otp === undefined));
    assert.equal((await api.get(`/api/v1/parcels/${s.parcel}`).set(h('r2'))).status, 404);

    const wrong = await api.post(`/api/v1/parcels/${s.parcel}/collect`).set(h('guard')).send({ otp: otp === '0000' ? '1111' : '0000' });
    assert.equal(wrong.status, 400);
    const helpNoName = await api.post(`/api/v1/parcels/${s.parcel}/collect`).set(h('guard')).send({ otp, collectedByType: 'daily_help' });
    assert.equal(helpNoName.status, 422);
    const ok = await api.post(`/api/v1/parcels/${s.parcel}/collect`).set(h('guard')).send({ otp, collectedByType: 'daily_help', collectedByName: 'Sunita (maid)' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, 'collected');
    assert.equal(ok.body.data.collectedBy.name, 'Sunita (maid)');
    assert.equal((await api.post(`/api/v1/parcels/${s.parcel}/collect`).set(h('guard')).send({ otp })).status, 409);
    const after = await api.get('/api/v1/parcels').set(h('r1'));
    assert.equal(after.body.data.find((x) => x._id === s.parcel).otp, undefined);
    assert.equal((await api.post('/api/v1/parcels').set(h('r1')).send({ unit: s.u101, courier: 'X' })).status, 403);
  });

  test('OTP locks after repeated wrong attempts; return to courier', async () => {
    const p = await api.post('/api/v1/parcels').set(h('guard')).send({ unit: s.u102, courier: 'Flipkart' });
    const real = (await api.get('/api/v1/parcels').set(h('r2'))).body.data[0].otp;
    const bad = real === '9999' ? '8888' : '9999';
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await api.post(`/api/v1/parcels/${p.body.data._id}/collect`).set(h('guard')).send({ otp: bad });
    }
    const locked = await api.post(`/api/v1/parcels/${p.body.data._id}/collect`).set(h('guard')).send({ otp: real });
    assert.equal(locked.status, 429);
    const ret = await api.post(`/api/v1/parcels/${p.body.data._id}/return`).set(h('guard')).send({ reason: 'Resident unreachable' });
    assert.equal(ret.body.data.status, 'returned');
  });

  test('reminder job nudges households about parcels older than 24h, once per interval', async () => {
    const { sendDueReminders } = await import('../src/modules/parcels/parcels.service.js');
    const p = await api.post('/api/v1/parcels').set(h('guard')).send({ unit: s.u102, courier: 'Myntra' });
    assert.equal((await sendDueReminders(settingsLookup)).reminded, 0);
    await models.Parcel.updateOne({ _id: p.body.data._id }, { receivedAt: new Date(Date.now() - 25 * 3600000) });
    assert.equal((await sendDueReminders(settingsLookup)).reminded, 1);
    assert.equal((await sendDueReminders(settingsLookup)).reminded, 0);
    assert.ok((await notes('r2')).some((n) => /waiting 1 day/.test(n.title)));
    const listed = await api.get('/api/v1/parcels?olderThanHours=24').set(h('guard'));
    assert.equal(listed.body.data[0].ageHours, 25);
    const stats = await api.get('/api/v1/parcels/stats').set(h('fm'));
    assert.equal(stats.body.data.ageing.days1to3, 1);
  });

  test('"leave at gate" preference lets the delivery drop off without approval', async () => {
    const pref = await api.post('/api/v1/parcels/preferences').set(h('r1')).send({ company: 'Swiggy' });
    assert.equal(pref.status, 201);
    const oneOff = await api.post('/api/v1/parcels/preferences').set(h('r1')).send({ oneOff: true, note: 'Out today' });
    assert.equal(oneOff.status, 201);
    const check = await api.get(`/api/v1/parcels/preferences/check?unit=${s.u101}&company=swiggy`).set(h('guard'));
    assert.equal(check.body.data.leaveAtGate, true);
    assert.equal((await api.get(`/api/v1/parcels/preferences/check?unit=${s.u102}&company=swiggy`).set(h('guard'))).body.data.leaveAtGate, false);

    const v = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Swiggy Rider', purpose: 'delivery', company: 'Swiggy' });
    assert.equal(v.status, 201);
    assert.equal(v.body.data.status, 'checked_out');
    assert.equal(v.body.data.leftAtGate, true);
    assert.equal(v.body.data.leaveAtGate, true);
    // the one-off "any company" rule is used by the first other delivery, then gone
    const zepto = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Zepto Rider', purpose: 'delivery', company: 'Zepto' });
    assert.equal(zepto.body.data.leftAtGate, true);
    const zepto2 = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Zepto Rider 2', purpose: 'delivery', company: 'Zepto' });
    assert.equal(zepto2.body.data.status, 'pending');
    const prefs = await api.get('/api/v1/parcels/preferences').set(h('r1'));
    assert.equal(prefs.body.data.length, 1);
    assert.equal((await api.delete(`/api/v1/parcels/preferences/${prefs.body.data[0]._id}`).set(h('r2'))).status, 404);
  });
});

describe('patrols', () => {
  test('checkpoints, route, scans with GPS and completion', async () => {
    const cp1 = await api.post('/api/v1/patrols/checkpoints').set(h('fm')).send({ name: 'Main gate', lat: 18.5204, lng: 73.8567, radiusM: 50 });
    const cp2 = await api.post('/api/v1/patrols/checkpoints').set(h('fm')).send({ name: 'Pump room' });
    const cp3 = await api.post('/api/v1/patrols/checkpoints').set(h('fm')).send({ name: 'Terrace' });
    assert.equal(cp1.status, 201);
    assert.match(cp1.body.data.qr, /^CHKPT:/);
    s.cp = [cp1.body.data, cp2.body.data, cp3.body.data];
    assert.equal((await api.post('/api/v1/patrols/checkpoints').set(h('guard')).send({ name: 'X' })).status, 403);

    const route = await api.post('/api/v1/patrols/routes').set(h('fm')).send({ name: 'Perimeter', checkpoints: [s.cp[0]._id, s.cp[1]._id], frequencyMinutes: 60, startTime: '00:00', endTime: '23:59' });
    assert.equal(route.status, 201, JSON.stringify(route.body));
    s.route = route.body.data._id;
    const route2 = await api.post('/api/v1/patrols/routes').set(h('fm')).send({ name: 'Roof check', checkpoints: [s.cp[2]._id], frequencyMinutes: 60, startTime: '00:00', endTime: '23:59' });
    s.route2 = route2.body.data._id;

    assert.equal((await api.post('/api/v1/patrols/scan').set(h('guard')).send({ code: 'CHKPT:nope12345' })).status, 404);
    assert.equal((await api.post('/api/v1/patrols/scan').set(h('r1')).send({ code: s.cp[0].qr })).status, 403);
    assert.equal((await api.post('/api/v1/patrols/scan').set(bearer(s.otherGuard.accessToken)).send({ code: s.cp[0].qr })).status, 404);

    const far = await api.post('/api/v1/patrols/scan').set(h('guard')).send({ code: s.cp[0].qr, lat: 18.53, lng: 73.86 });
    assert.equal(far.status, 201, JSON.stringify(far.body));
    assert.equal(far.body.data.scan.gpsOk, false);
    assert.ok(far.body.data.scan.distanceM > 500);
    assert.equal(far.body.data.rounds[0].status, 'in_progress');
    const again = await api.post('/api/v1/patrols/scan').set(h('guard')).send({ code: s.cp[0].qr });
    assert.equal(again.body.data.rounds[0].alreadyScanned, true);

    const current = await api.get('/api/v1/patrols/current').set(h('guard'));
    const perim = current.body.data.find((r) => r.route.name === 'Perimeter');
    assert.equal(perim.checkpoints.filter((c) => c.scannedAt).length, 1);
    s.slot = perim.slot;
  });

  test('missed-checkpoint job closes overdue rounds and alerts', async () => {
    const { detectMissedRounds } = await import('../src/modules/patrols/patrols.service.js');
    const later = new Date(new Date(s.slot.windowEnd).getTime() + 11 * 60000); // past the 10-min grace
    const r = await detectMissedRounds(settingsLookup, later);
    assert.equal(r.partial, 1); // Perimeter: 1 of 2 scanned
    assert.equal(r.missed, 1); // Roof check: nothing scanned
    const perim = await models.PatrolRound.findOne({ route: s.route }).populate('missedCheckpoints', 'name').lean();
    assert.equal(perim.status, 'partial');
    assert.deepEqual(perim.missedCheckpoints.map((c) => c.name), ['Pump room']);
    assert.ok((await notes('guard')).some((n) => n.type === 'patrol' && /Patrol missed: Roof check/.test(n.title)));
    assert.ok((await notes('fm')).some((n) => /Patrol incomplete: Perimeter/.test(n.title)));
    assert.deepEqual(await detectMissedRounds(settingsLookup, later), { missed: 0, partial: 0 });

    const report = await api.get(`/api/v1/patrols/report?from=${new Date(Date.now() - 86400000).toISOString()}&to=${new Date(Date.now() + 86400000).toISOString()}`).set(h('fm'));
    assert.equal(report.status, 200);
    assert.ok(report.body.data.routes.some((x) => x.name === 'Perimeter' && x.partial === 1));
    assert.equal(report.body.data.guards[0].gpsMismatch, 1);
    assert.equal((await api.get('/api/v1/patrols/report').set(h('guard'))).status, 403);
  });

  test('completing all checkpoints marks the round completed', async () => {
    const { PatrolRound } = models;
    await PatrolRound.deleteMany({ route: s.route });
    await api.post('/api/v1/patrols/scan').set(h('guard')).send({ code: s.cp[0].qr, lat: 18.5204, lng: 73.8567 });
    const done = await api.post('/api/v1/patrols/scan').set(h('guard2')).send({ code: s.cp[1].qr });
    const round = done.body.data.rounds.find((x) => x.route.name === 'Perimeter');
    assert.equal(round.status, 'completed');
    const del = await api.delete(`/api/v1/patrols/checkpoints/${s.cp[0]._id}`).set(h('fm'));
    assert.equal(del.status, 409);
  });
});

describe('vehicles, ANPR / RFID and barrier commands', () => {
  test('device keys and registered vehicle with RFID tag', async () => {
    const ev = await api.post('/api/v1/devices').set(h('admin')).send({ name: 'Gate ANPR', type: 'anpr', scopes: ['gate:events'] });
    const cmd = await api.post('/api/v1/devices').set(h('admin')).send({ name: 'Boom barrier', type: 'barrier', scopes: ['gate:commands'] });
    const otherEv = await api.post('/api/v1/devices').set(h('other')).send({ name: 'Other ANPR', type: 'anpr', scopes: ['gate:events'] });
    s.evKey = ev.body.data.key;
    s.cmdKey = cmd.body.data.key;
    s.otherEvKey = otherEv.body.data.key;

    const car = await api.post('/api/v1/vehicles').set(h('r1')).send({ number: 'MH 12 AB 1234', type: 'four_wheeler', rfidTag: 'SELF-ASSIGNED' });
    assert.equal(car.status, 201, JSON.stringify(car.body));
    assert.equal(car.body.data.rfidTag, undefined); // residents cannot assign tags
    s.car = car.body.data._id;
    const tag = await api.patch(`/api/v1/vehicles/${s.car}/rfid`).set(h('fm')).send({ rfidTag: 'tag-0001' });
    assert.equal(tag.status, 200);
    assert.equal(tag.body.data.rfidTag, 'TAG-0001');
    assert.equal((await api.patch(`/api/v1/vehicles/${s.car}/rfid`).set(h('r1')).send({ rfidTag: 'X1234' })).status, 403);
    const bike = await api.post('/api/v1/vehicles').set(h('r2')).send({ number: 'MH12XY0001', type: 'two_wheeler' });
    s.bike = bike.body.data._id;
    const dupTag = await api.patch(`/api/v1/vehicles/${s.bike}/rfid`).set(h('fm')).send({ rfidTag: 'TAG-0001' });
    assert.equal(dupTag.status, 409);
  });

  test('ANPR known, unknown and blacklisted plates; RFID reads', async () => {
    const known = await api.post('/api/v1/gate-devices/events').set(device(s.evKey)).send({ type: 'anpr', plate: 'MH 12 AB 1234', direction: 'in', gate: 'Main gate', imageUrl: 'https://cam.example/1.jpg' });
    assert.equal(known.status, 201, JSON.stringify(known.body));
    assert.equal(known.body.data.decision, 'allow');
    assert.equal(known.body.data.openBarrier, true);
    assert.equal(known.body.data.match, 'resident');
    assert.equal(known.body.data.vehicle.unit, 'A-101');

    const unknown = await api.post('/api/v1/gate-devices/events').set(device(s.evKey)).send({ type: 'anpr', plate: 'DL01CC0007', direction: 'in', eventId: 'cam-evt-77' });
    assert.equal(unknown.body.data.decision, 'deny');
    assert.equal(unknown.body.data.match, 'unknown');
    assert.ok((await notes('guard')).some((n) => /Unknown vehicle/.test(n.title)));
    assert.ok((await notes('fm')).some((n) => /Unknown vehicle/.test(n.title)));
    const resend = await api.post('/api/v1/gate-devices/events').set(device(s.evKey)).send({ type: 'anpr', plate: 'DL01CC0007', direction: 'in', eventId: 'cam-evt-77' });
    assert.equal(resend.status, 200);
    assert.equal(resend.body.data.movementId, unknown.body.data.movementId);
    const leaving = await api.post('/api/v1/gate-devices/events').set(device(s.evKey)).send({ type: 'anpr', plate: 'DL01CC0007', direction: 'out' });
    assert.equal(leaving.body.data.decision, 'allow'); // allowUnknownExit default

    await api.post('/api/v1/visitors/watchlist').set(h('fm')).send({ type: 'block', vehicleNumber: 'UP16BAD001', reason: 'Stolen vehicle report' });
    const blocked = await api.post('/api/v1/gate-devices/events').set(device(s.evKey)).send({ type: 'anpr', plate: 'UP16BAD001', direction: 'in' });
    assert.equal(blocked.body.data.decision, 'deny');
    assert.equal(blocked.body.data.match, 'blocked');
    assert.ok((await notes('admin')).some((n) => /Blocked at gate: vehicle UP16BAD001/.test(n.title)));

    const rfid = await api.post('/api/v1/gate-devices/events').set(device(s.evKey)).send({ type: 'rfid', tag: 'tag-0001', direction: 'out' });
    assert.equal(rfid.body.data.decision, 'allow');
    assert.equal(rfid.body.data.plate, 'MH12AB1234');
    const badTag = await api.post('/api/v1/gate-devices/events').set(device(s.evKey)).send({ type: 'rfid', tag: 'TAG-9999', direction: 'in' });
    assert.equal(badTag.body.data.decision, 'deny');
    assert.match(badTag.body.data.reason, /Unknown RFID tag/);

    // the same plate in another society is unknown there
    const isolated = await api.post('/api/v1/gate-devices/events').set(device(s.otherEvKey)).send({ type: 'anpr', plate: 'MH12AB1234', direction: 'in' });
    assert.equal(isolated.body.data.match, 'unknown');
  });

  test('device scopes and authentication are enforced', async () => {
    assert.equal((await api.post('/api/v1/gate-devices/events').send({ type: 'anpr', plate: 'MH12AB1234', direction: 'in' })).status, 401);
    assert.equal((await api.post('/api/v1/gate-devices/events').set(device('chk_wrong')).send({ type: 'anpr', plate: 'MH12AB1234', direction: 'in' })).status, 401);
    assert.equal((await api.post('/api/v1/gate-devices/events').set(device(s.cmdKey)).send({ type: 'anpr', plate: 'MH12AB1234', direction: 'in' })).status, 403);
    assert.equal((await api.get('/api/v1/gate-devices/commands').set(device(s.evKey))).status, 403);
    assert.equal((await api.post('/api/v1/gate-devices/events').set(device(s.evKey)).send({ type: 'rfid', direction: 'in' })).status, 422);
    // a user token is not a device key
    assert.equal((await api.post('/api/v1/gate-devices/events').set(h('admin')).send({ type: 'anpr', plate: 'MH12AB1234', direction: 'in' })).status, 401);
  });

  test('movement log and manual plate check', async () => {
    const all = await api.get('/api/v1/vehicles/movements?limit=50').set(h('guard'));
    assert.ok(all.body.meta.total >= 7);
    const unknown = await api.get('/api/v1/vehicles/movements?match=unknown').set(h('fm'));
    assert.ok(unknown.body.data.every((m) => m.match === 'unknown'));
    const mine = await api.get('/api/v1/vehicles/movements').set(h('r1'));
    assert.ok(mine.body.data.length >= 2);
    assert.ok(mine.body.data.every((m) => m.unit?.label === 'A-101'));
    const manual = await api.post('/api/v1/vehicles/movements').set(h('guard')).send({ plate: 'GJ05QQ1111', direction: 'in', gate: 'Service gate' });
    assert.equal(manual.status, 201);
    assert.equal(manual.body.data.match, 'unknown');
    const lookup = await api.get('/api/v1/vehicles/lookup?plate=MH12AB1234').set(h('guard'));
    assert.equal(lookup.body.data.match, 'resident');
    assert.equal((await api.get('/api/v1/vehicles/movements').set(bearer(s.other.accessToken))).body.meta.total, 1);
  });

  test('barrier command queue: guard opens, device polls and acks', async () => {
    assert.equal((await api.post('/api/v1/gate-devices/barrier/open').set(h('r1')).send({ gate: 'Main gate' })).status, 403);
    const cmd = await api.post('/api/v1/gate-devices/barrier/open').set(h('guard')).send({ gate: 'Main gate', reason: 'Ambulance' });
    assert.equal(cmd.status, 201);
    assert.equal(cmd.body.data.status, 'pending');
    const stale = await models.BarrierCommand.create({ society: s.admin.user.society._id, gate: 'Main gate', expiresAt: new Date(Date.now() - 1000) });

    const other = await api.get('/api/v1/gate-devices/commands?gate=Service%20gate').set(device(s.cmdKey));
    assert.equal(other.body.data.length, 0);
    const poll = await api.get('/api/v1/gate-devices/commands?gate=Main%20gate').set(device(s.cmdKey));
    assert.equal(poll.status, 200);
    assert.deepEqual(poll.body.data.map((c) => c._id), [cmd.body.data._id]);
    const ack = await api.post(`/api/v1/gate-devices/commands/${cmd.body.data._id}/ack`).set(device(s.cmdKey)).send({ status: 'done' });
    assert.equal(ack.body.data.status, 'done');
    const ackAgain = await api.post(`/api/v1/gate-devices/commands/${cmd.body.data._id}/ack`).set(device(s.cmdKey)).send({ status: 'done' });
    assert.equal(ackAgain.status, 200);
    assert.equal((await api.post(`/api/v1/gate-devices/commands/${stale._id}/ack`).set(device(s.cmdKey)).send({})).status, 409);
    assert.equal((await api.get('/api/v1/gate-devices/commands').set(device(s.cmdKey))).body.data.length, 0);
    const history = await api.get('/api/v1/gate-devices/barrier/commands').set(h('guard'));
    assert.equal(history.body.data.find((c) => c._id === cmd.body.data._id).ackedBy.name, 'Boom barrier');
    assert.equal(history.body.data.find((c) => c._id === String(stale._id)).status, 'expired');
  });
});

describe('parking', () => {
  test('areas and slots; allotment conflicts', async () => {
    const area = await api.post('/api/v1/parking/areas').set(h('fm')).send({ name: 'Basement 1', level: 'B1' });
    assert.equal(area.status, 201);
    s.area = area.body.data._id;
    const range = await api.post('/api/v1/parking/slots').set(h('fm')).send({ area: s.area, prefix: 'P', from: 1, to: 3, type: 'four_wheeler', covered: true });
    assert.deepEqual(range.body.data, { created: 3, skipped: 0 });
    await api.post('/api/v1/parking/slots').set(h('fm')).send({ area: s.area, number: 'V1', pool: 'visitor' });
    await api.post('/api/v1/parking/slots').set(h('fm')).send({ area: s.area, number: 'T1', type: 'two_wheeler' });
    assert.equal((await api.post('/api/v1/parking/slots').set(h('fm')).send({ area: s.area, number: 'P1' })).status, 409);
    const slots = (await api.get('/api/v1/parking/slots?limit=50').set(h('fm'))).body.data;
    s.slot = Object.fromEntries(slots.map((x) => [x.number, x._id]));

    const ok = await api.post(`/api/v1/parking/slots/${s.slot.P1}/allot`).set(h('fm')).send({ unit: s.u101, vehicles: [s.car] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.unit.label, 'A-101');
    const car = (await api.get('/api/v1/vehicles').set(h('r1'))).body.data[0];
    assert.equal(car.parkingSlot, 'P1');

    const taken = await api.post(`/api/v1/parking/slots/${s.slot.P1}/allot`).set(h('fm')).send({ unit: s.u102 });
    assert.equal(taken.status, 409);
    assert.match(taken.body.error.message, /already allotted to A-101/);
    assert.equal((await api.post(`/api/v1/parking/slots/${s.slot.V1}/allot`).set(h('fm')).send({ unit: s.u102 })).status, 409);
    assert.equal((await api.post(`/api/v1/parking/slots/${s.slot.P2}/allot`).set(h('fm')).send({ unit: s.u101, vehicles: [s.car] })).status, 409);
    assert.equal((await api.post(`/api/v1/parking/slots/${s.slot.P2}/allot`).set(h('fm')).send({ unit: s.u102, vehicles: [s.car] })).status, 400);
    const noFit = await api.post(`/api/v1/parking/slots/${s.slot.T1}/allot`).set(h('fm')).send({ unit: s.u101, vehicles: [s.car] });
    assert.equal(noFit.status, 400);
    assert.match(noFit.body.error.message, /does not fit/);
    const two = await api.post(`/api/v1/parking/slots/${s.slot.T1}/allot`).set(h('fm')).send({ unit: s.u102, vehicles: [s.bike] });
    assert.equal(two.status, 200);
    assert.equal((await api.post(`/api/v1/parking/slots/${s.slot.P2}/allot`).set(h('guard')).send({ unit: s.u102 })).status, 403);

    const my = await api.get('/api/v1/parking/my').set(h('r1'));
    assert.deepEqual(my.body.data.slots.map((x) => x.number), ['P1']);
    const rel = await api.post(`/api/v1/parking/slots/${s.slot.P1}/release`).set(h('fm'));
    assert.equal(rel.status, 200);
    assert.equal((await api.get('/api/v1/vehicles').set(h('r1'))).body.data[0].parkingSlot, undefined);
    assert.equal((await api.post(`/api/v1/parking/slots/${s.slot.P1}/allot`).set(h('fm')).send({ unit: s.u102 })).status, 200);
    const summary = await api.get('/api/v1/parking/summary').set(h('fm'));
    assert.equal(summary.body.data.allotted, 2);
    assert.equal(summary.body.data.visitorSlots, 1);
  });

  test('visitor parking: one car per slot and overstay job', async () => {
    const { overstayAlerts } = await import('../src/modules/parking/parking.service.js');
    const start = await api.post('/api/v1/parking/visitor-sessions').set(h('guard')).send({ slot: s.slot.V1, vehicleNumber: 'MH14 VV 2020', unit: s.u102, hours: 1 });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    const second = await api.post('/api/v1/parking/visitor-sessions').set(h('guard')).send({ slot: s.slot.V1, vehicleNumber: 'MH14VV3030', hours: 1 });
    assert.equal(second.status, 409);
    assert.equal((await api.post('/api/v1/parking/visitor-sessions').set(h('guard')).send({ slot: s.slot.P3, vehicleNumber: 'MH14VV3030', hours: 1 })).status, 409);

    assert.equal((await overstayAlerts(settingsLookup)).alerted, 0);
    await models.VisitorParking.updateOne({ _id: start.body.data._id }, { expectedOutAt: new Date(Date.now() - 20 * 60000) });
    assert.equal((await overstayAlerts(settingsLookup)).alerted, 1);
    assert.equal((await overstayAlerts(settingsLookup)).alerted, 0);
    assert.ok((await notes('guard')).some((n) => n.type === 'parking' && /overstaying/.test(n.title)));
    assert.ok((await notes('r2')).some((n) => /MH14VV2020 has overstayed/.test(n.title)));
    const end = await api.post(`/api/v1/parking/visitor-sessions/${start.body.data._id}/end`).set(h('guard'));
    assert.equal(end.body.data.status, 'completed');
    assert.equal((await api.post('/api/v1/parking/visitor-sessions').set(h('guard')).send({ slot: s.slot.V1, vehicleNumber: 'MH14VV3030', hours: 1 })).status, 201);
  });

  test('violations notify the owner household; dispute and resolve', async () => {
    const v = await api.post('/api/v1/parking/violations').set(h('guard')).send({ vehicleNumber: 'mh12ab1234', type: 'double_parking', location: 'Near B1 ramp', fine: '₹500 per bye-law 12' });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    assert.equal(v.body.data.unit.label, 'A-101');
    assert.ok((await notes('r1')).some((n) => /Parking violation: MH12AB1234/.test(n.title)));
    assert.equal((await api.get('/api/v1/parking/violations').set(h('r2'))).body.meta.total, 0);
    assert.equal((await api.post(`/api/v1/parking/violations/${v.body.data._id}/dispute`).set(h('r2')).send({ note: 'Not mine' })).status, 409);
    const d = await api.post(`/api/v1/parking/violations/${v.body.data._id}/dispute`).set(h('r1')).send({ note: 'Moved in 2 minutes' });
    assert.equal(d.body.data.status, 'disputed');
    const r = await api.post(`/api/v1/parking/violations/${v.body.data._id}/resolve`).set(h('fm')).send({ status: 'dismissed', resolution: 'Warning only' });
    assert.equal(r.body.data.status, 'dismissed');
    const unregistered = await api.post('/api/v1/parking/violations').set(h('guard')).send({ vehicleNumber: 'KA05AA0001', type: 'no_parking_zone' });
    assert.equal(unregistered.body.data.unit, undefined);
  });

  test('EV charger booking with overlap prevention and kWh recording', async () => {
    const ch = await api.post('/api/v1/parking/ev/chargers').set(h('fm')).send({ name: 'EV-1', location: 'B1', ratePerKwh: 1500, slotMinutes: 60, openTime: '06:00', closeTime: '23:00' });
    assert.equal(ch.status, 201);
    const { localDateString } = await import('../src/common/utils/dates.js');
    const tomorrow = localDateString(new Date(Date.now() + 86400000));
    const b = await api.post('/api/v1/parking/ev/bookings').set(h('r1')).send({ charger: ch.body.data._id, date: tomorrow, startTime: '10:00', endTime: '12:00' });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const clash = await api.post('/api/v1/parking/ev/bookings').set(h('r2')).send({ charger: ch.body.data._id, date: tomorrow, startTime: '11:00', endTime: '13:00' });
    assert.equal(clash.status, 409);
    const touching = await api.post('/api/v1/parking/ev/bookings').set(h('r2')).send({ charger: ch.body.data._id, date: tomorrow, startTime: '12:00', endTime: '13:00' });
    assert.equal(touching.status, 201);
    assert.equal((await api.post('/api/v1/parking/ev/bookings').set(h('r2')).send({ charger: ch.body.data._id, date: tomorrow, startTime: '05:00', endTime: '06:00' })).status, 400);
    assert.equal((await api.post('/api/v1/parking/ev/bookings').set(h('r2')).send({ charger: ch.body.data._id, date: tomorrow, startTime: '14:00', endTime: '14:30' })).status, 400);
    const avail = await api.get(`/api/v1/parking/ev/chargers/${ch.body.data._id}/availability?date=${tomorrow}`).set(h('r2'));
    assert.equal(avail.body.data.booked.length, 2);
    assert.equal(avail.body.data.booked.filter((x) => x.mine).length, 1);

    assert.equal((await api.post(`/api/v1/parking/ev/bookings/${b.body.data._id}/start`).set(h('r2'))).status, 404);
    await api.post(`/api/v1/parking/ev/bookings/${b.body.data._id}/start`).set(h('r1'));
    const done = await api.post(`/api/v1/parking/ev/bookings/${b.body.data._id}/complete`).set(h('guard')).send({ kwh: 7.5 });
    assert.equal(done.body.data.status, 'completed');
    assert.equal(done.body.data.costEstimate, 11250);
    const cancel = await api.post(`/api/v1/parking/ev/bookings/${touching.body.data._id}/cancel`).set(h('r2')).send({});
    assert.equal(cancel.body.data.status, 'cancelled');
  });
});

describe('emergency directory and child safety', () => {
  test('directory is managed by FM and visible to everyone in order', async () => {
    const a = await api.post('/api/v1/emergency/contacts').set(h('fm')).send({ name: 'Ambulance', category: 'ambulance', phone: '108', available24x7: true });
    const b = await api.post('/api/v1/emergency/contacts').set(h('fm')).send({ name: 'City Hospital', category: 'hospital', phone: '+91 20 1234 5678' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.body.data.order, 1);
    assert.equal((await api.post('/api/v1/emergency/contacts').set(h('r1')).send({ name: 'X', phone: '100' })).status, 403);
    await api.post('/api/v1/emergency/contacts/reorder').set(h('fm')).send({ ids: [b.body.data._id, a.body.data._id] });
    const list = await api.get('/api/v1/emergency/contacts').set(h('r1'));
    assert.deepEqual(list.body.data.map((c) => c.name), ['City Hospital', 'Ambulance']);
    assert.equal((await api.get('/api/v1/emergency/contacts').set(h('guard'))).body.data.length, 2);
    assert.equal((await api.get('/api/v1/emergency/contacts').set(bearer(s.other.accessToken))).body.data.length, 0);
  });

  test('guard raises child exit alert; parent must acknowledge; escalation', async () => {
    const child = await api.post('/api/v1/emergency/children').set(h('r1')).send({ name: 'Aarav', age: 7, alertOnExit: true });
    assert.equal(child.status, 201);
    const optOut = await api.post('/api/v1/emergency/children').set(h('r2')).send({ name: 'Teen Tara', age: 16, alertOnExit: false });
    assert.equal((await api.get('/api/v1/emergency/children').set(h('guard'))).body.data.length, 1);
    assert.equal((await api.get('/api/v1/emergency/children').set(h('r2'))).body.data.length, 1);
    assert.equal((await api.post(`/api/v1/emergency/children/${optOut.body.data._id}/exit-alert`).set(h('guard')).send({})).status, 400);
    assert.equal((await api.post(`/api/v1/emergency/children/${child.body.data._id}/exit-alert`).set(h('r1')).send({})).status, 403);

    const alert = await api.post(`/api/v1/emergency/children/${child.body.data._id}/exit-alert`).set(h('guard')).send({ gate: 'Main gate', note: 'Walking towards the road' });
    assert.equal(alert.status, 201);
    const n = (await notes('r1b')).find((x) => x.type === 'child_alert');
    assert.match(n.title, /Aarav is leaving/);
    assert.equal((await api.post(`/api/v1/emergency/children/${child.body.data._id}/exit-alert`).set(h('guard')).send({})).status, 409);

    assert.equal((await api.post(`/api/v1/emergency/child-alerts/${alert.body.data._id}/acknowledge`).set(h('r2')).send({ response: 'ok' })).status, 409);
    const ack = await api.post(`/api/v1/emergency/child-alerts/${alert.body.data._id}/acknowledge`).set(h('r1b')).send({ response: 'stop', note: 'Hold him please' });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.data.response, 'stop');
    assert.ok((await notes('guard')).some((x) => /STOP Aarav/.test(x.title)));
    assert.ok((await notes('guard2')).some((x) => /Hold Aarav/.test(x.title)));
    assert.equal((await api.post(`/api/v1/emergency/child-alerts/${alert.body.data._id}/acknowledge`).set(h('r1')).send({})).status, 409);

    const { escalateAlerts } = await import('../src/modules/emergency/emergency.service.js');
    await models.ChildAlert.collection.updateOne({ _id: new models.Types.ObjectId(alert.body.data._id) }, { $set: { createdAt: new Date(Date.now() - 10 * 60000) } });
    const second = await models.ChildAlert.create({ society: s.admin.user.society._id, child: child.body.data._id, unit: s.u101, raisedBy: s.guard.user._id });
    await models.ChildAlert.collection.updateOne({ _id: second._id }, { $set: { createdAt: new Date(Date.now() - 5 * 60000) } });
    assert.equal((await escalateAlerts(settingsLookup)).escalated, 1); // the acknowledged one is not escalated
    assert.ok((await notes('fm')).some((x) => /No answer: Aarav/.test(x.title)));
    assert.equal((await escalateAlerts(settingsLookup)).escalated, 0);
  });
});

describe('guard duty', () => {
  test('handover must be acknowledged by the next guard; incidents and occurrence book', async () => {
    const ho = await api.post('/api/v1/guard-duty/handovers').set(h('guard')).send({ shift: 'night', notes: 'Quiet night', keys: [{ name: 'Clubhouse', status: 'with_guard' }], pendingItems: [{ text: 'Call plumber for B-wing' }] });
    assert.equal(ho.status, 201, JSON.stringify(ho.body));
    assert.equal((await api.post(`/api/v1/guard-duty/handovers/${ho.body.data._id}/acknowledge`).set(h('guard')).send({})).status, 403);
    const ack = await api.post(`/api/v1/guard-duty/handovers/${ho.body.data._id}/acknowledge`).set(h('guard2')).send({ note: 'Keys received' });
    assert.equal(ack.body.data.status, 'acknowledged');
    assert.equal(ack.body.data.toGuard.name, 'guard2 user');
    assert.equal((await api.post(`/api/v1/guard-duty/handovers/${ho.body.data._id}/acknowledge`).set(h('guard2')).send({})).status, 409);
    assert.equal((await api.get('/api/v1/guard-duty/handovers').set(h('r1'))).status, 403);

    const inc = await api.post('/api/v1/guard-duty/incidents').set(h('guard')).send({ type: 'suspicious', severity: 'high', title: 'Person climbing wall', vehicleNumber: 'MH12 AB 1234', location: 'East wall' });
    assert.equal(inc.status, 201, JSON.stringify(inc.body));
    assert.match(inc.body.data.number, /^INC-/);
    assert.equal(inc.body.data.unit.label, 'A-101');
    assert.ok((await notes('fm')).some((x) => /Incident INC-/.test(x.title)));
    assert.equal((await api.post(`/api/v1/guard-duty/incidents/${inc.body.data._id}/close`).set(h('guard')).send({ actionTaken: 'x' })).status, 403);
    const closed = await api.post(`/api/v1/guard-duty/incidents/${inc.body.data._id}/close`).set(h('fm')).send({ actionTaken: 'Police informed' });
    assert.equal(closed.body.data.status, 'closed');

    await api.post('/api/v1/guard-duty/occurrence-book').set(h('guard')).send({ text: 'Water tanker arrived', category: 'maintenance' });
    const ob = await api.get('/api/v1/guard-duty/occurrence-book').set(h('fm'));
    const cats = ob.body.data.entries.map((e) => e.category);
    assert.ok(cats.includes('handover') && cats.includes('incident') && cats.includes('maintenance'));
    assert.equal((await api.get('/api/v1/guard-duty/occurrence-book').set(bearer(s.otherGuard.accessToken))).body.data.entries.length, 0);
  });
});

describe('visitor analytics', () => {
  test('summary for managers with heatmap, purposes and denied counts; Excel export', async () => {
    const res = await api.get('/api/v1/visitors/analytics').set(h('fm'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.ok(d.totals.total >= 10);
    assert.ok(d.totals.denied >= 1);
    assert.ok(d.totals.blocked >= 1);
    assert.ok(d.totals.leftAtGate >= 2);
    assert.equal(d.heatmap.length, 7);
    assert.equal(d.heatmap[0].hours.length, 24);
    assert.equal(d.heatmap.reduce((sum, r) => sum + r.hours.reduce((a, b) => a + b, 0), 0), d.totals.total);
    assert.ok(d.byPurpose.some((p) => p.purpose === 'delivery'));
    assert.equal(d.perDay.length, 30);
    assert.ok(d.approval.responses >= 1);
    assert.equal((await api.get('/api/v1/visitors/analytics').set(h('guard'))).status, 403);
    assert.equal((await api.get('/api/v1/visitors/analytics').set(h('r1'))).status, 403);
    const other = await api.get('/api/v1/visitors/analytics').set(bearer(s.other.accessToken));
    assert.equal(other.body.data.totals.total, 0);

    const xl = await api.get('/api/v1/visitors/analytics/export').set(h('fm')).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(xl.status, 200);
    assert.match(xl.headers['content-type'], /spreadsheetml/);
    assert.equal(xl.body.subarray(0, 2).toString(), 'PK');
  });

  test('security settings: admin edits, guards read', async () => {
    assert.equal((await api.get('/api/v1/visitors/security-settings').set(h('guard'))).body.data.escalationSeconds, 90);
    assert.equal((await api.patch('/api/v1/visitors/security-settings').set(h('fm')).send({ escalationSeconds: 60 })).status, 403);
    const upd = await api.patch('/api/v1/visitors/security-settings').set(h('admin')).send({ escalationSeconds: 60, allowUnknownExit: false });
    assert.equal(upd.body.data.escalationSeconds, 60);
    const out = await api.post('/api/v1/gate-devices/events').set(device(s.evKey)).send({ type: 'anpr', plate: 'TN09ZZ0001', direction: 'out' });
    assert.equal(out.body.data.decision, 'deny');
  });
});

describe('tenant isolation', () => {
  test('another society sees none of this data', async () => {
    const o = bearer(s.other.accessToken);
    assert.equal((await api.get('/api/v1/visitors/watchlist').set(o)).body.meta.total, 0);
    assert.equal((await api.get('/api/v1/parcels').set(o)).body.meta.total, 0);
    assert.equal((await api.get(`/api/v1/parcels/${s.parcel}`).set(o)).status, 404);
    assert.equal((await api.get('/api/v1/patrols/checkpoints').set(o)).body.data.length, 0);
    assert.equal((await api.get('/api/v1/parking/slots').set(o)).body.meta.total, 0);
    assert.equal((await api.post(`/api/v1/parking/slots/${s.slot.P2}/allot`).set(o).send({ unit: s.u101 })).status, 404);
    assert.equal((await api.get('/api/v1/parking/violations').set(o)).body.meta.total, 0);
    assert.equal((await api.get('/api/v1/guard-duty/incidents').set(o)).body.meta.total, 0);
    assert.equal((await api.get('/api/v1/emergency/child-alerts').set(o)).body.meta.total, 0);
    assert.equal((await api.get('/api/v1/gate-devices/barrier/commands').set(o)).body.meta.total, 0);
    assert.equal((await api.delete(`/api/v1/visitors/watchlist/${s.blockEntry}`).set(o)).status, 404);
  });
});
