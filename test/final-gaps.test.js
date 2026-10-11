import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
// IST wall-clock time on a fixed future day, so slot maths doesn't depend on when the test runs
const day = new Date(Date.now() + 5 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const at = (hhmm) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();

before(async () => {
  api = await setup();
  const reg = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Gaps Society' }, admin: { name: 'Gap Admin', email: 'admin@gap.test', password: 'Password@123' } });
  s.admin = reg.body.data;
  s.h = bearer(s.admin.accessToken);
  const block = await api.post('/api/v1/blocks').set(s.h).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(s.h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 3 });
  s.units = (await api.get('/api/v1/units').set(s.h)).body.data;
  s.hall = (await api.post('/api/v1/amenities').set(s.h).send({ name: 'Party Hall', capacity: 1, openTime: '09:00', closeTime: '22:00', slotMinutes: 60 })).body.data;
});
after(teardown);

describe('events reserve their amenity venue', () => {
  test('creating an event books the hall; residents then see the slot taken', async () => {
    const ev = await api.post('/api/v1/events').set(s.h).send({ title: 'Annual meet', amenity: s.hall._id, startAt: at('18:00'), endAt: at('21:00') });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    s.event = ev.body.data;
    const avail = await api.get(`/api/v1/amenities/${s.hall._id}/availability?date=${day}`).set(s.h);
    const slot = avail.body.data.slots.find((x) => x.startTime === '19:00');
    assert.equal(slot.available, 0, 'hall is reserved for the event');
  });

  test('a clashing event is refused and nothing is created', async () => {
    const clash = await api.post('/api/v1/events').set(s.h).send({ title: 'Clash', amenity: s.hall._id, startAt: at('20:00'), endAt: at('22:00') });
    assert.equal(clash.status, 409);
    const list = await api.get('/api/v1/events').set(s.h);
    assert.ok(!list.body.data.some((e) => e.title === 'Clash'));
  });

  test('rescheduling moves the reservation; cancelling releases it', async () => {
    const moved = await api.patch(`/api/v1/events/${s.event._id}`).set(s.h).send({ startAt: at('10:00'), endAt: at('12:00') });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    let slots = (await api.get(`/api/v1/amenities/${s.hall._id}/availability?date=${day}`).set(s.h)).body.data.slots;
    assert.equal(slots.find((x) => x.startTime === '19:00').available, 1, 'old time freed');
    assert.equal(slots.find((x) => x.startTime === '10:00').available, 0, 'new time held');

    await api.post(`/api/v1/events/${s.event._id}/cancel`).set(s.h).send({ reason: 'Rain' });
    slots = (await api.get(`/api/v1/amenities/${s.hall._id}/availability?date=${day}`).set(s.h)).body.data.slots;
    assert.equal(slots.find((x) => x.startTime === '10:00').available, 1, 'released on cancel');
  });
});

describe('seating the elected committee', () => {
  test('winners of a published election become an upcoming committee term', async () => {
    const add = async (name, email, unit) =>
      (await api.post('/api/v1/users').set(s.h).send({ name, email, password: 'Password@123', role: 'resident', unit, residentType: 'owner' })).body.data;
    const m1 = await add('Ravi Secretary', 'r1@gap.test', s.units[0]._id);
    const m2 = await add('Neha Treasurer', 'r2@gap.test', s.units[1]._id);
    const m3 = await add('Arun Member', 'r3@gap.test', s.units[2]._id);

    const { default: Election } = await import('../src/modules/elections/election.model.js');
    const { default: Nomination } = await import('../src/modules/elections/nomination.model.js');
    const sid = s.admin.user.society._id;
    const pos = { sec: new mongoose.Types.ObjectId(), tre: new mongoose.Types.ObjectId(), mem: new mongoose.Types.ObjectId() };
    const election = await Election.create({
      society: sid,
      number: 'ELC-000001',
      title: 'Committee election 2026',
      status: 'published',
      positions: [{ _id: pos.sec, title: 'Hon. Secretary' }, { _id: pos.tre, title: 'Treasurer' }, { _id: pos.mem, title: 'Committee member', seats: 1 }],
    });
    const nom = (p, m) =>
      Nomination.create({ society: sid, election: election._id, position: p, candidate: m._id, candidateUser: m.user, candidateName: m.name, nominatedBy: s.admin.user._id, status: 'approved' });
    const [n1, n2, n3] = await Promise.all([nom(pos.sec, m1), nom(pos.tre, m2), nom(pos.mem, m3)]);
    await Election.updateOne(
      { _id: election._id },
      { results: [{ position: pos.sec, title: 'Hon. Secretary', winners: [n1._id] }, { position: pos.tre, title: 'Treasurer', winners: [n2._id] }, { position: pos.mem, title: 'Committee member', winners: [n3._id] }] },
    );

    const body = { election: election._id, name: 'Managing Committee 2026-2031', startDate: day, endDate: '2031-03-31' };
    const res = await api.post('/api/v1/committee/terms/from-election').set(s.h).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const byPos = Object.fromEntries(res.body.data.term.positions.map((p) => [p.position, p.name]));
    assert.deepEqual(byPos, { secretary: 'Ravi Secretary', treasurer: 'Neha Treasurer', member: 'Arun Member' });
    assert.equal(res.body.data.term.status, 'upcoming', 'admin still activates it');

    const again = await api.post('/api/v1/committee/terms/from-election').set(s.h).send(body);
    assert.equal(again.status, 409, 'one committee per election');
  });

  test('unpublished elections and unresolved ties are refused', async () => {
    const { default: Election } = await import('../src/modules/elections/election.model.js');
    const sid = s.admin.user.society._id;
    const draft = await Election.create({ society: sid, number: 'ELC-000002', title: 'Draft', status: 'closed' });
    const r1 = await api.post('/api/v1/committee/terms/from-election').set(s.h).send({ election: draft._id, name: 'X Committee', startDate: day, endDate: '2031-03-31' });
    assert.equal(r1.status, 409);
    const tied = await Election.create({ society: sid, number: 'ELC-000003', title: 'Tied', status: 'published', results: [{ title: 'President', tie: true, winners: [] }] });
    const r2 = await api.post('/api/v1/committee/terms/from-election').set(s.h).send({ election: tied._id, name: 'Y Committee', startDate: day, endDate: '2031-03-31' });
    assert.equal(r2.status, 409);
    assert.match(r2.body.error.message, /tie/i);
  });
});
