import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
let models;
const s = {};
const PW = 'Password@123';

const login = async (identifier) => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password: PW });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const h = (who) => bearer(s[who].accessToken);
const device = (key) => ({ 'X-Device-Key': key });
const hour = 3600000;

before(async () => {
  api = await setup();
  models = {
    Visitor: (await import('../src/modules/visitors/visitor.model.js')).default,
    GuestPass: (await import('../src/modules/visitors/guestPass.model.js')).default,
    GateSyncOp: (await import('../src/modules/visitors/gateSyncOp.model.js')).default,
    VehicleMovement: (await import('../src/modules/vehicles/vehicleMovement.model.js')).default,
    HelpAttendance: (await import('../src/modules/dailyHelp/helpAttendance.model.js')).default,
    ...(await import('../src/modules/gates/gate.model.js')),
  };

  const reg = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Many Gates Enclave' }, admin: { name: 'Admin Gates', email: 'admin@mg.test', password: PW } });
  s.admin = reg.body.data;
  s.society = s.admin.user.society._id;
  const block = await api.post('/api/v1/blocks').set(h('admin')).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(h('admin')).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 2, areaSqft: 900 });
  const units = (await api.get('/api/v1/units').set(h('admin'))).body.data;
  s.u101 = units.find((u) => u.label === 'A-101')._id;
  s.u102 = units.find((u) => u.label === 'A-102')._id;
  // No approval needed, so guard-logged entries go straight in and the tests stay about gates.
  await api.patch('/api/v1/society/me/settings').set(h('admin')).send({ visitorApprovalRequired: false });

  const people = [
    ['r1', 'resident', '9700000001', s.u101, 'owner'],
    ['guard', 'guard', '9700000002'],
    ['guard2', 'guard', '9700000003'],
    ['fm', 'facility_manager', '9700000004'],
  ];
  for (const [key, role, phone, unit, residentType] of people) {
    const body = { name: `${key} user`, email: `${key}@mg.test`, phone, password: PW, role };
    if (unit) Object.assign(body, { unit, residentType });
    // eslint-disable-next-line no-await-in-loop
    const res = await api.post('/api/v1/users').set(h('admin')).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // eslint-disable-next-line no-await-in-loop
    s[key] = await login(`${key}@mg.test`);
  }

  const other = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Single Gate Towers' }, admin: { name: 'Other Admin', email: 'admin@sg.test', password: PW } });
  s.other = other.body.data;
  await api.post('/api/v1/users').set(h('other')).send({ name: 'Other guard', email: 'guard@sg.test', password: PW, role: 'guard' });
  s.otherGuard = await login('guard@sg.test');
});
after(teardown);

describe('gate master', () => {
  test('every society gets a default "Main gate" on first use', async () => {
    const res = await api.get('/api/v1/gates').set(h('guard'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.length, 1);
    const [main] = res.body.data;
    assert.equal(main.name, 'Main gate');
    assert.equal(main.code, 'MAIN');
    assert.ok(main.allowVisitors && main.allowVehicles && main.allowStaff && main.allowDeliveries);
    assert.equal(main.isPedestrianOnly, false);
    s.main = main._id;
    // calling again does not create a second one
    assert.equal((await api.get('/api/v1/gates').set(h('fm'))).body.data.length, 1);
  });

  test('management creates gates; guards and residents may list but not edit', async () => {
    const club = await api.post('/api/v1/gates').set(h('fm')).send({ name: 'Gate 2 — Club side', code: 'G2', allowStaff: false, allowDeliveries: false });
    assert.equal(club.status, 201, JSON.stringify(club.body));
    assert.equal(club.body.data.code, 'G2');
    s.club = club.body.data._id;
    const service = await api.post('/api/v1/gates').set(h('admin')).send({ name: 'Service gate', allowVisitors: false, allowVehicles: false, notes: 'Behind the STP' });
    assert.equal(service.status, 201);
    assert.ok(service.body.data.code, 'a code is derived when none is given');
    s.service = service.body.data._id;
    const ped = await api.post('/api/v1/gates').set(h('fm')).send({ name: 'Pedestrian gate', code: 'PED', allowVehicles: false, allowStaff: false, allowDeliveries: false, isPedestrianOnly: true });
    s.ped = ped.body.data._id;

    assert.equal((await api.post('/api/v1/gates').set(h('guard')).send({ name: 'Guard gate' })).status, 403);
    assert.equal((await api.post('/api/v1/gates').set(h('r1')).send({ name: 'My gate' })).status, 403);
    assert.equal((await api.patch(`/api/v1/gates/${s.club}`).set(h('guard')).send({ name: 'Renamed' })).status, 403);
    assert.equal((await api.patch(`/api/v1/gates/${s.club}`).set(h('r1')).send({ name: 'Renamed' })).status, 403);
    assert.equal((await api.delete(`/api/v1/gates/${s.club}`).set(h('guard'))).status, 403);
    assert.equal((await api.post('/api/v1/gates/reorder').set(h('guard')).send({ ids: [s.club, s.main] })).status, 403);

    const forResident = await api.get('/api/v1/gates').set(h('r1'));
    assert.equal(forResident.status, 200);
    assert.deepEqual(forResident.body.data.map((g) => g.name), ['Main gate', 'Gate 2 — Club side', 'Service gate', 'Pedestrian gate']);
  });

  test('names are unique per society ignoring case; codes too; at least one kind', async () => {
    const dup = await api.post('/api/v1/gates').set(h('fm')).send({ name: '  service   GATE ' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.message, /already exists/);
    assert.equal((await api.post('/api/v1/gates').set(h('fm')).send({ name: 'Back gate', code: 'g2' })).status, 409);
    assert.equal((await api.patch(`/api/v1/gates/${s.club}`).set(h('fm')).send({ name: 'Main Gate' })).status, 409);
    assert.equal((await api.post('/api/v1/gates').set(h('fm')).send({ name: 'Nothing gate', allowVisitors: false, allowVehicles: false, allowStaff: false, allowDeliveries: false })).status, 422);
    assert.equal((await api.patch(`/api/v1/gates/${s.ped}`).set(h('fm')).send({ allowVisitors: false })).status, 422);
    // the same name is fine in another society
    assert.equal((await api.post('/api/v1/gates').set(h('other')).send({ name: 'Service gate' })).status, 201);
  });

  test('reorder and edit', async () => {
    const res = await api.post('/api/v1/gates/reorder').set(h('fm')).send({ ids: [s.main, s.service, s.club, s.ped] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((g) => g.name), ['Main gate', 'Service gate', 'Gate 2 — Club side', 'Pedestrian gate']);
    const edit = await api.patch(`/api/v1/gates/${s.service}`).set(h('fm')).send({ notes: 'Opens 6 AM–10 PM' });
    assert.equal(edit.body.data.notes, 'Opens 6 AM–10 PM');
    assert.equal(edit.body.data.allowStaff, true, 'a partial edit keeps the other flags');
  });
});

describe('the guard’s gate', () => {
  test('guard sets their current gate; entries without a gate use it, else the first gate', async () => {
    const none = await api.get('/api/v1/gates/my-post').set(h('guard'));
    assert.equal(none.body.data.gate, null);
    const noGate = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Default Dev', purpose: 'guest' });
    assert.equal(noGate.status, 201, JSON.stringify(noGate.body));
    assert.equal(noGate.body.data.entryGateName, 'Main gate');
    assert.equal(noGate.body.data.entryGate, s.main);

    const set = await api.put('/api/v1/gates/my-post').set(h('guard')).send({ gateId: s.club });
    assert.equal(set.status, 200);
    assert.equal((await api.get('/api/v1/gates/my-post').set(h('guard'))).body.data.gate.name, 'Gate 2 — Club side');
    assert.equal((await api.put('/api/v1/gates/my-post').set(h('fm')).send({ gateId: s.club })).status, 403);
    assert.equal((await api.put('/api/v1/gates/my-post').set(h('guard2')).send({ gateId: '64b000000000000000000000' })).status, 400);

    const atPost = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Post Priya', purpose: 'guest' });
    assert.equal(atPost.body.data.entryGateName, 'Gate 2 — Club side');
    // another guard is not affected
    const other = await api.post('/api/v1/visitors').set(h('guard2')).send({ unit: s.u101, name: 'Second Sam', purpose: 'guest' });
    assert.equal(other.body.data.entryGateName, 'Main gate');

    const dash = await api.get('/api/v1/dashboard').set(h('guard'));
    assert.equal(dash.body.data.gate.name, 'Gate 2 — Club side');
    assert.equal(dash.body.data.atGate.inside, 1);
  });
});

describe('recording the gate', () => {
  test('visitor entry and check-out record entry and exit gates', async () => {
    const v = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u102, name: 'Explicit Ella', purpose: 'guest', gateId: s.main });
    assert.equal(v.status, 201);
    assert.equal(v.body.data.entryGateName, 'Main gate');
    const out = await api.post(`/api/v1/visitors/${v.body.data._id}/check-out`).set(h('guard')).send({ gateId: s.ped });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.exitGateName, 'Pedestrian gate');
    assert.equal(String(out.body.data.exitGate), s.ped);
  });

  test('service gate refuses a visitor, unless the resident confirmed by phone (override)', async () => {
    const refused = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Wrong Way Will', purpose: 'guest', gateId: s.service });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'GATE_NOT_ALLOWED');
    assert.match(refused.body.error.message, /Service gate does not take visitors — use Main gate/);
    assert.equal(await models.Visitor.countDocuments({ name: 'Wrong Way Will' }), 0);

    const override = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Wrong Way Will', purpose: 'guest', gateId: s.service, guardApproved: true });
    assert.equal(override.status, 201);
    assert.equal(override.body.data.status, 'checked_in');
    assert.match(override.body.data.gateOverride.reason, /does not take visitors/);
    assert.equal(override.body.data.entryGateName, 'Service gate');

    const delivery = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Zomato rider', purpose: 'delivery', company: 'Zomato', gateId: s.service });
    assert.equal(delivery.status, 201);
    assert.equal(delivery.body.data.gateOverride, undefined);

    const car = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Driver Dan', purpose: 'guest', vehicleNumber: 'MH12CD3333', gateId: s.ped });
    assert.equal(car.status, 403);
    assert.match(car.body.error.message, /people on foot only/);
    const foot = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Walker Wanda', purpose: 'guest', gateId: s.ped });
    assert.equal(foot.status, 201);
  });

  test('parcels are taken only at gates that take deliveries', async () => {
    const refused = await api.post('/api/v1/parcels').set(h('guard')).send({ unit: s.u101, courier: 'Amazon', gateId: s.club });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error.message, /does not take deliveries/);
    const ok = await api.post('/api/v1/parcels').set(h('guard')).send({ unit: s.u101, courier: 'Amazon', gateId: s.service });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.gateName, 'Service gate');
    const list = await api.get(`/api/v1/parcels?gate=${s.service}`).set(h('guard'));
    assert.equal(list.body.data.length, 1);
  });

  test('child exit alert records the gate', async () => {
    const child = await api.post('/api/v1/emergency/children').set(h('r1')).send({ name: 'Aarav', age: 9 });
    assert.equal(child.status, 201, JSON.stringify(child.body));
    const alert = await api.post(`/api/v1/emergency/children/${child.body.data._id}/exit-alert`).set(h('guard')).send({ gateId: s.ped });
    assert.equal(alert.status, 201, JSON.stringify(alert.body));
    assert.equal(alert.body.data.gate, 'Pedestrian gate');
    assert.equal(String(alert.body.data.gateId), s.ped);
  });
});

describe('guest passes limited to gates', () => {
  const window = () => ({ validFrom: new Date(Date.now() - hour).toISOString(), validTo: new Date(Date.now() + 4 * hour).toISOString() });

  test('a pass for Main gate is refused at Gate 2 (and not used up), accepted at Main gate', async () => {
    const pass = await api.post('/api/v1/visitors/passes').set(h('r1')).send({ guestName: 'Main Only Meena', maxUses: 1, gates: [s.main], ...window() });
    assert.equal(pass.status, 201, JSON.stringify(pass.body));
    assert.deepEqual(pass.body.data.gates.map((g) => g.name), ['Main gate']);
    const refused = await api.post('/api/v1/visitors/passes/verify').set(h('guard')).send({ code: pass.body.data.code, gateId: s.club });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'GATE_NOT_ALLOWED');
    assert.equal(refused.body.error.message, 'This pass is only valid at Main gate');
    assert.equal((await models.GuestPass.findById(pass.body.data._id).lean()).usedCount, 0);

    const ok = await api.post('/api/v1/visitors/passes/verify').set(h('guard')).send({ code: pass.body.data.code, gateId: s.main });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.entryGateName, 'Main gate');

    const listed = await api.get('/api/v1/visitors/passes').set(h('r1'));
    assert.equal(listed.body.data.find((p) => p._id === pass.body.data._id).gates[0].name, 'Main gate');
  });

  test('a pass without gates works at any gate that takes visitors; overrides are recorded', async () => {
    const any = await api.post('/api/v1/visitors/passes').set(h('r1')).send({ guestName: 'Anywhere Anil', maxUses: 2, ...window() });
    assert.deepEqual(any.body.data.gates, []);
    const atClub = await api.post('/api/v1/visitors/passes/verify').set(h('guard')).send({ code: any.body.data.code, gateId: s.club });
    assert.equal(atClub.status, 201);
    const atService = await api.post('/api/v1/visitors/passes/verify').set(h('guard')).send({ code: any.body.data.code, gateId: s.service });
    assert.equal(atService.status, 403);
    assert.match(atService.body.error.message, /does not take visitors/);

    const limited = await api.post('/api/v1/visitors/passes').set(h('r1')).send({ guestName: 'Override Om', gates: [s.main], ...window() });
    const forced = await api.post('/api/v1/visitors/passes/verify').set(h('guard')).send({ code: limited.body.data.code, gateId: s.club, guardApproved: true });
    assert.equal(forced.status, 201);
    assert.equal(forced.body.data.gateOverride.reason, 'This pass is only valid at Main gate');
  });

  test('passes cannot name a gate of another society or a closed gate', async () => {
    const otherGate = (await api.get('/api/v1/gates').set(h('other'))).body.data[0]._id;
    const res = await api.post('/api/v1/visitors/passes').set(h('r1')).send({ guestName: 'Foreign Gate', gates: [otherGate], ...window() });
    assert.equal(res.status, 400);
  });
});

describe('daily help allowed gates', () => {
  test('a helper limited to the Service gate is refused at Main gate; leaving is allowed anywhere', async () => {
    const help = await api.post('/api/v1/daily-help').set(h('fm')).send({ name: 'Raju Cleaner', type: 'cleaner', units: [s.u101], allowedGates: [s.service] });
    assert.equal(help.status, 201, JSON.stringify(help.body));
    assert.equal(help.body.data.allowedGates[0].name, 'Service gate');
    const { passcode, _id } = help.body.data;

    const refused = await api.post('/api/v1/daily-help/gate-scan').set(h('guard')).send({ passcode, gateId: s.main });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.message, 'Raju Cleaner is only valid at Service gate');
    const inside = await api.post('/api/v1/daily-help/gate-scan').set(h('guard')).send({ passcode, gateId: s.service });
    assert.equal(inside.status, 200, JSON.stringify(inside.body));
    assert.equal(inside.body.data.direction, 'in');
    const insideHere = await api.get(`/api/v1/daily-help?inside=true&gate=${s.service}`).set(h('guard'));
    assert.deepEqual(insideHere.body.data.map((x) => x.name), ['Raju Cleaner']);
    const out = await api.post('/api/v1/daily-help/gate-scan').set(h('guard')).send({ passcode, gateId: s.main });
    assert.equal(out.body.data.direction, 'out');
    const row = await models.HelpAttendance.findOne({ help: _id }).lean();
    assert.equal(row.inGateName, 'Service gate');
    assert.equal(row.outGateName, 'Main gate');
  });

  test('a gate that takes no staff refuses helpers; residents cannot set allowed gates', async () => {
    const help = await api.post('/api/v1/daily-help').set(h('r1')).send({ name: 'Kamla Cook', type: 'cook', allowedGates: [s.ped] });
    assert.equal(help.status, 201);
    assert.deepEqual(help.body.data.allowedGates, []);
    const refused = await api.post('/api/v1/daily-help/gate-scan').set(h('guard')).send({ passcode: help.body.data.passcode, gateId: s.club });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error.message, /does not take daily help/);
    const edit = await api.patch(`/api/v1/daily-help/${help.body.data._id}`).set(h('fm')).send({ allowedGates: [s.main, s.service] });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.data.allowedGates.length, 2);
  });
});

describe('devices and barrier at a gate', () => {
  test('device keys are linked to a gate; its events use that gate', async () => {
    const cam = await api.post('/api/v1/devices').set(h('admin')).send({ name: 'Club gate ANPR', type: 'anpr', scopes: ['gate:events'], gateId: s.club });
    assert.equal(cam.status, 201, JSON.stringify(cam.body));
    assert.equal(String(cam.body.data.gate), s.club);
    s.camKey = cam.body.data.key;
    s.cam = cam.body.data._id;
    const list = await api.get('/api/v1/devices').set(h('admin'));
    assert.equal(list.body.data.find((d) => d._id === s.cam).gate.name, 'Gate 2 — Club side');

    // the request's gate name is ignored for a linked device
    const ev = await api.post('/api/v1/gate-devices/events').set(device(s.camKey)).send({ type: 'anpr', plate: 'MH12ZZ0001', direction: 'in', gate: 'Main gate' });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    assert.equal(ev.body.data.gate, 'Gate 2 — Club side');
    assert.equal(ev.body.data.gateId, s.club);
    const m = await models.VehicleMovement.findById(ev.body.data.movementId).lean();
    assert.equal(String(m.gateId), s.club);

    const otherGate = (await api.get('/api/v1/gates').set(h('other'))).body.data[0]._id;
    assert.equal((await api.post('/api/v1/devices').set(h('admin')).send({ name: 'Foreign', type: 'anpr', scopes: ['gate:events'], gateId: otherGate })).status, 400);
    const unlink = await api.patch(`/api/v1/devices/${s.cam}`).set(h('admin')).send({ gateId: null });
    assert.equal(unlink.body.data.gate, undefined);
    const legacy = await api.post('/api/v1/gate-devices/events').set(device(s.camKey)).send({ type: 'anpr', plate: 'MH12ZZ0002', direction: 'in', gate: 'Service gate' });
    assert.equal(legacy.body.data.gate, 'Service gate', 'an unlinked device may still name its gate');
    await api.patch(`/api/v1/devices/${s.cam}`).set(h('admin')).send({ gateId: s.club });
  });

  test('barrier open goes to the guard’s gate and only that gate’s controller sees it', async () => {
    const clubBarrier = await api.post('/api/v1/devices').set(h('admin')).send({ name: 'Club barrier', type: 'barrier', scopes: ['gate:commands'], gateId: s.club });
    const mainBarrier = await api.post('/api/v1/devices').set(h('admin')).send({ name: 'Main barrier', type: 'barrier', scopes: ['gate:commands'], gateId: s.main });

    const cmd = await api.post('/api/v1/gate-devices/barrier/open').set(h('guard')).send({ gateId: s.club, reason: 'Resident car' });
    assert.equal(cmd.status, 201, JSON.stringify(cmd.body));
    assert.equal(cmd.body.data.gate, 'Gate 2 — Club side');
    assert.equal(String(cmd.body.data.gateId), s.club);
    // guard is posted at the club gate: no gate in the request opens that one
    const implicit = await api.post('/api/v1/gate-devices/barrier/open').set(h('guard')).send({});
    assert.equal(String(implicit.body.data.gateId), s.club);

    const atMain = await api.get('/api/v1/gate-devices/commands').set(device(mainBarrier.body.data.key));
    assert.equal(atMain.body.data.length, 0);
    const atClub = await api.get('/api/v1/gate-devices/commands?gate=Main%20gate').set(device(clubBarrier.body.data.key));
    assert.deepEqual(atClub.body.data.map((c) => c._id).sort(), [cmd.body.data._id, implicit.body.data._id].sort());

    const history = await api.get(`/api/v1/gate-devices/barrier/commands?gate=${s.club}`).set(h('guard'));
    assert.equal(history.body.data.length, 2);
    const names = await api.get('/api/v1/gate-devices/gates').set(h('guard'));
    assert.ok(names.body.data.includes('Gate 2 — Club side'));
  });

  test('manual vehicle log is refused at a gate that takes no vehicles', async () => {
    const refused = await api.post('/api/v1/vehicles/movements').set(h('guard')).send({ plate: 'MH12QQ1111', direction: 'in', gateId: s.ped });
    assert.equal(refused.status, 403);
    const ok = await api.post('/api/v1/vehicles/movements').set(h('guard')).send({ plate: 'MH12QQ1111', direction: 'in', gateId: s.main });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.gate, 'Main gate');
  });

  test('old movement documents that only have a gate name still list and filter', async () => {
    await models.VehicleMovement.collection.insertOne({
      society: new models.Gate.base.Types.ObjectId(s.society),
      plate: 'OLD0001',
      direction: 'in',
      gate: 'Main gate',
      source: 'manual',
      match: 'unknown',
      decision: 'deny',
      occurredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const all = await api.get('/api/v1/vehicles/movements?limit=50').set(h('fm'));
    assert.equal(all.status, 200);
    assert.ok(all.body.data.some((m) => m.plate === 'OLD0001' && m.gate === 'Main gate' && !m.gateId));
    const byId = await api.get(`/api/v1/vehicles/movements?gate=${s.main}&limit=50`).set(h('fm'));
    assert.ok(byId.body.data.some((m) => m.plate === 'OLD0001'));
    assert.ok(byId.body.data.some((m) => m.plate === 'MH12QQ1111'));
    assert.ok(byId.body.data.every((m) => m.gate === 'Main gate'));
    const byName = await api.get('/api/v1/vehicles/movements?gate=main%20GATE&limit=50').set(h('fm'));
    assert.equal(byName.body.meta.total, byId.body.meta.total);
  });
});

describe('offline sync keeps the gate', () => {
  test('queued ops carry the gate they happened at', async () => {
    const inAt = new Date(Date.now() - 30 * 60000).toISOString();
    const res = await api.post('/api/v1/visitors/sync').set(h('guard2')).send({
      ops: [
        { key: 'gtab-0001-entry', kind: 'entry', occurredAt: inAt, data: { unit: s.u101, name: 'Offline Ojas', purpose: 'guest', guardApproved: true, gateId: s.club } },
        { key: 'gtab-0002-out', kind: 'checkout', occurredAt: new Date().toISOString(), gateId: s.ped, data: { entryKey: 'gtab-0001-entry' } },
        { key: 'gtab-0003-entry', kind: 'entry', occurredAt: inAt, data: { unit: s.u101, name: 'Offline Wrong Gate', purpose: 'guest', gateId: s.service } },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.results.map((r) => r.status), ['ok', 'ok', 'conflict']);
    assert.equal(res.body.data.results[2].code, 'GATE_NOT_ALLOWED');
    const v = await models.Visitor.findOne({ clientKey: 'gtab-0001-entry' }).lean();
    assert.equal(v.entryGateName, 'Gate 2 — Club side');
    assert.equal(v.exitGateName, 'Pedestrian gate');
    const op = await models.GateSyncOp.findOne({ key: 'gtab-0001-entry' }).lean();
    assert.equal(String(op.gate), s.club);
  });
});

describe('reports by gate', () => {
  test('inside-now and visitors list filter by gate', async () => {
    const inside = await api.get(`/api/v1/visitors?status=checked_in&gate=${s.club}&limit=50`).set(h('guard'));
    assert.ok(inside.body.data.length >= 1);
    assert.ok(inside.body.data.every((v) => v.entryGateName === 'Gate 2 — Club side' && v.status === 'checked_in'));
    const all = await api.get(`/api/v1/visitors?gate=${s.service}&limit=50`).set(h('fm'));
    assert.ok(all.body.data.every((v) => v.entryGateName === 'Service gate'));
  });

  test('analytics breaks entries down by gate with the busiest hour', async () => {
    const res = await api.get('/api/v1/visitors/analytics').set(h('fm'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { byGate, totals } = res.body.data;
    assert.equal(byGate.reduce((n, g) => n + g.count, 0), totals.total);
    for (const id of [s.main, s.club, s.service, s.ped]) {
      // eslint-disable-next-line no-await-in-loop
      const count = await models.Visitor.countDocuments({ entryGate: id });
      const row = byGate.find((g) => g.gate === id);
      assert.equal(row.count, count, `count for ${row.name}`);
      assert.equal(row.hours.length, 24);
      assert.equal(row.hours.reduce((a, b) => a + b, 0), count);
      assert.equal(row.hours[row.peakHour], Math.max(...row.hours));
    }
    const one = await api.get(`/api/v1/visitors/analytics?gate=${s.club}`).set(h('fm'));
    assert.equal(one.body.data.byGate.length, 1);
    assert.equal(one.body.data.byGate[0].name, 'Gate 2 — Club side');
    const xlsx = await api.get('/api/v1/visitors/analytics/export').set(h('fm'));
    assert.equal(xlsx.status, 200);
  });

  test('admin dashboard gate activity carries the gate name', async () => {
    const res = await api.get('/api/v1/dashboard').set(h('admin'));
    assert.ok(res.body.data.recentVisitors.length);
    assert.ok(res.body.data.recentVisitors.every((v) => v.entryGateName));
  });
});

describe('deactivate instead of delete', () => {
  test('a used gate is deactivated, an unused one deleted; the last open gate stays', async () => {
    const used = await api.delete(`/api/v1/gates/${s.ped}`).set(h('fm'));
    assert.equal(used.status, 200);
    assert.equal(used.body.data.deleted, false);
    assert.equal(used.body.data.gate.active, false);
    assert.ok(!(await api.get('/api/v1/gates').set(h('guard'))).body.data.some((g) => g._id === s.ped));
    assert.ok((await api.get('/api/v1/gates?includeInactive=true').set(h('fm'))).body.data.some((g) => g._id === s.ped));
    // closed gates take no entries
    const closed = await api.post('/api/v1/visitors').set(h('guard')).send({ unit: s.u101, name: 'Late Lata', purpose: 'guest', gateId: s.ped });
    assert.equal(closed.status, 400);
    assert.match(closed.body.error.message, /closed/);
    // history still filters by it
    assert.ok((await api.get(`/api/v1/vehicles/movements?gate=${s.ped}`).set(h('fm'))).status === 200);

    const spare = await api.post('/api/v1/gates').set(h('fm')).send({ name: 'Spare gate' });
    const gone = await api.delete(`/api/v1/gates/${spare.body.data._id}`).set(h('fm'));
    assert.equal(gone.body.data.deleted, true);
    assert.equal(await models.Gate.countDocuments({ _id: spare.body.data._id }), 0);

    const otherGates = (await api.get('/api/v1/gates').set(h('other'))).body.data;
    await api.delete(`/api/v1/gates/${otherGates[1]._id}`).set(h('other'));
    const last = await api.delete(`/api/v1/gates/${otherGates[0]._id}`).set(h('other'));
    assert.equal(last.status, 409);
    assert.match(last.body.error.message, /at least one open gate/);
  });
});

describe('cross-society isolation', () => {
  test('another society cannot see, edit or use these gates', async () => {
    const theirs = await api.get('/api/v1/gates').set(h('otherGuard'));
    assert.ok(theirs.body.data.every((g) => ![s.main, s.club, s.service].includes(g._id)));
    assert.equal((await api.patch(`/api/v1/gates/${s.club}`).set(h('other')).send({ name: 'Hijacked' })).status, 404);
    assert.equal((await api.delete(`/api/v1/gates/${s.club}`).set(h('other'))).status, 404);
    const unit = await api.post('/api/v1/blocks').set(h('other')).send({ name: 'T' });
    await api.post('/api/v1/units/bulk').set(h('other')).send({ block: unit.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 1, areaSqft: 800 });
    const theirUnit = (await api.get('/api/v1/units').set(h('other'))).body.data[0]._id;
    const entry = await api.post('/api/v1/visitors').set(h('otherGuard')).send({ unit: theirUnit, name: 'Gate Thief', purpose: 'guest', gateId: s.main });
    assert.equal(entry.status, 400);
    assert.match(entry.body.error.message, /Unknown gate/);
    assert.equal((await api.put('/api/v1/gates/my-post').set(h('otherGuard')).send({ gateId: s.main })).status, 400);
    assert.equal((await api.post('/api/v1/gate-devices/barrier/open').set(h('otherGuard')).send({ gateId: s.club })).status, 400);
  });
});
