import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
const PASSWORD = 'Password@123';

before(async () => {
  api = await setup();
  const reg = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Gate Society' }, admin: { name: 'Gate Admin', email: 'admin@gs.test', password: PASSWORD } });
  s.admin = reg.body.data;
  const h = bearer(s.admin.accessToken);
  const block = await api.post('/api/v1/blocks').set(h).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 1 });
  s.unit = (await api.get('/api/v1/units').set(h)).body.data[0]._id;
  for (const [key, body] of [
    ['guard', { name: 'Gate Guard', email: 'guard@gs.test', role: 'guard' }],
    ['resident', { name: 'Gate Resident', email: 'res@gs.test', role: 'resident', unit: s.unit, residentType: 'owner' }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await api.post('/api/v1/users').set(h).send({ ...body, password: PASSWORD });
    // eslint-disable-next-line no-await-in-loop
    s[key] = (await api.post('/api/v1/auth/login').send({ identifier: body.email, password: PASSWORD })).body.data;
  }
});
after(teardown);

test('a guard can send a waiting visitor back; residents use their own deny', async () => {
  const entry = await api.post('/api/v1/visitors').set(bearer(s.guard.accessToken)).send({ unit: s.unit, name: 'Unknown Seller', purpose: 'other' });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  const id = entry.body.data._id;
  assert.equal(entry.body.data.status, 'pending');

  assert.equal((await api.post(`/api/v1/visitors/${id}/send-back`).set(bearer(s.resident.accessToken)).send({})).status, 403, 'send-back is for guards');

  const back = await api.post(`/api/v1/visitors/${id}/send-back`).set(bearer(s.guard.accessToken)).send({});
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.data.status, 'denied');
  assert.equal(back.body.data.note, 'Sent back by guard');

  const again = await api.post(`/api/v1/visitors/${id}/send-back`).set(bearer(s.guard.accessToken)).send({});
  assert.equal(again.status, 409, 'already decided');
});
