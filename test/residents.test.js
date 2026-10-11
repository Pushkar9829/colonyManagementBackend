import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
const PASSWORD = 'Password@123';
// 1x1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

const login = async (identifier) => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password: PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const H = (who) => bearer(s[who].accessToken);
const upload = async (who, folder = 'documents') => {
  const res = await api.post('/api/v1/uploads').set(H(who)).field('folder', folder).attach('file', PNG, 'file.png');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data._id;
};
const IST = (d = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const istTime = (d) => new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).slice(0, 5);
const plusDays = (n) => IST(Date.now() + n * 86400000);
const notesOf = async (who) => (await api.get('/api/v1/notifications?limit=100').set(H(who))).body.data;
const models = {};
const sign = async (orderId) => {
  const { mockProvider } = await import('../src/modules/payments/providers.js');
  const paymentId = `mock_pay_${Math.random().toString(16).slice(2, 10)}`;
  return { orderId, paymentId, signature: mockProvider.sign(orderId, paymentId) };
};

before(async () => {
  api = await setup();
  for (const [key, path] of [
    ['Membership', '../src/modules/users/membership.model.js'],
    ['DailyHelp', '../src/modules/dailyHelp/dailyHelp.model.js'],
    ['HelpAttendance', '../src/modules/dailyHelp/helpAttendance.model.js'],
    ['Booking', '../src/modules/amenities/booking.model.js'],
    ['AmenityPayment', '../src/modules/amenities/amenityPayment.model.js'],
    ['AmenityPass', '../src/modules/amenities/amenityPass.model.js'],
    ['Complaint', '../src/modules/complaints/complaint.model.js'],
    ['Lease', '../src/modules/tenancy/lease.model.js'],
    ['KycDocument', '../src/modules/kyc/kycDocument.model.js'],
    ['Bill', '../src/modules/billing/bill.model.js'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    models[key] = (await import(path)).default;
  }

  const reg = await api.post('/api/v1/auth/register-society').send({
    society: { name: 'Palm Grove' },
    admin: { name: 'Admin Palm', email: 'admin@pg.test', password: PASSWORD },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  s.admin = reg.body.data;
  const h = H('admin');
  const block = await api.post('/api/v1/blocks').set(h).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 4, areaSqft: 900 });
  const units = (await api.get('/api/v1/units?limit=50').set(h)).body.data;
  s.units = Object.fromEntries(units.map((u) => [u.label, u._id]));

  const people = [
    ['r1', 'r1@pg.test', '9700000001', 'resident', 'A-101', 'owner'],
    ['o2', 'o2@pg.test', '9700000002', 'resident', 'A-102', 'owner'],
    ['t2', 't2@pg.test', '9700000003', 'resident', 'A-102', 'tenant'],
    ['r3', 'r3@pg.test', '9700000004', 'resident', 'A-103', 'owner'],
    ['guard', 'guard@pg.test', '9700000005', 'guard'],
    ['staff', 'staff@pg.test', '9700000006', 'staff'],
    ['fm', 'fm@pg.test', '9700000007', 'facility_manager'],
  ];
  for (const [key, email, phone, role, unit, residentType] of people) {
    const body = { name: `${key} person`, email, phone, password: PASSWORD, role };
    if (unit) Object.assign(body, { unit: s.units[unit], residentType });
    // eslint-disable-next-line no-await-in-loop
    const res = await api.post('/api/v1/users').set(h).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    s[`${key}Membership`] = res.body.data._id;
    // eslint-disable-next-line no-await-in-loop
    s[key] = await login(email);
  }

  // A second society for isolation checks.
  const other = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Elsewhere' }, admin: { name: 'Other Admin', email: 'admin@ow.test', password: PASSWORD } });
  s.otherAdmin = other.body.data;
});
after(teardown);

describe('household profile', () => {
  test('resident manages family, pets, contacts and medical notes of their own unit', async () => {
    const empty = await api.get('/api/v1/household/me').set(H('r1'));
    assert.equal(empty.status, 200);
    assert.equal(empty.body.data.members.length, 0);
    assert.equal(empty.body.data.unit.label, 'A-101');

    const photo = await upload('r1', 'household');
    const m = await api.post('/api/v1/household/me/members').set(H('r1')).send({ name: 'Dadi Ji', relation: 'grandparent', dob: '1945-03-10', bloodGroup: 'B+', elderly: true, conditions: 'Diabetic', photo });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    const member = m.body.data.members[0];
    assert.ok(member.age >= 80);
    assert.ok(member.photo.url);

    const cert = await upload('r1');
    const p = await api.post('/api/v1/household/me/pets').set(H('r1')).send({ name: 'Bruno', type: 'dog', breed: 'Labrador', vaccinationDate: '2026-01-15', vaccinationCertificate: cert, registrationNumber: 'PMC-123' });
    assert.equal(p.status, 201);
    assert.equal(p.body.data.pets[0].vaccinationCertificate.mimetype, 'image/png');

    const prof = await api.patch('/api/v1/household/me').set(H('r1')).send({ emergencyContacts: [{ name: 'Brother Raj', relation: 'brother', phone: '9811100000' }], medicalNotes: 'Oxygen cylinder in bedroom' });
    assert.equal(prof.status, 200);
    assert.equal(prof.body.data.emergencyContacts.length, 1);
    const med = await api.put('/api/v1/household/me/medical').set(H('r1')).send({ bloodGroup: 'O+', allergies: 'Penicillin' });
    assert.equal(med.body.data.myMedical.allergies, 'Penicillin');

    const upd = await api.patch(`/api/v1/household/me/members/${member._id}`).set(H('r1')).send({ specialNeeds: true });
    assert.equal(upd.body.data.members[0].specialNeeds, true);
    s.r1Member = member._id;

    // A fake future date is rejected
    const bad = await api.post('/api/v1/household/me/members').set(H('r1')).send({ name: 'Baby', dob: '2999-01-01' });
    assert.equal(bad.status, 422);
  });

  test('households are scoped to the own unit', async () => {
    const other = await api.get('/api/v1/household/me').set(H('r3'));
    assert.equal(other.body.data.members.length, 0, 'A-103 does not see A-101 family');
    const tamper = await api.patch(`/api/v1/household/me/members/${s.r1Member}`).set(H('r3')).send({ name: 'Hacked' });
    assert.equal(tamper.status, 404);
    const del = await api.delete(`/api/v1/household/me/members/${s.r1Member}`).set(H('r3'));
    assert.equal(del.status, 404);
    const stolen = await upload('r3', 'household');
    const reuse = await api.post('/api/v1/household/me/members').set(H('r1')).send({ name: 'Someone', photo: stolen });
    assert.equal(reuse.status, 400, 'cannot attach another person\'s upload');
  });

  test('managers view all households; residents and guards cannot list them', async () => {
    const list = await api.get('/api/v1/household').set(H('fm'));
    assert.equal(list.status, 200);
    const a101 = list.body.data.find((r) => r.unit.label === 'A-101');
    assert.equal(a101.members, 1);
    assert.equal(a101.elderly, 1);
    assert.equal(list.body.meta.total, 4);
    const flagged = await api.get('/api/v1/household?medicalOnly=true').set(H('admin'));
    assert.equal(flagged.body.meta.total, 1);
    const one = await api.get(`/api/v1/household/units/${s.units['A-101']}`).set(H('admin'));
    assert.equal(one.body.data.pets[0].name, 'Bruno');
    assert.equal((await api.get('/api/v1/household').set(H('r1'))).status, 403);
    assert.equal((await api.get('/api/v1/household').set(H('guard'))).status, 403);
    assert.equal((await api.get(`/api/v1/household/units/${s.units['A-101']}`).set(H('guard'))).status, 403);
    const iso = await api.get(`/api/v1/household/units/${s.units['A-101']}`).set(bearer(s.otherAdmin.accessToken));
    assert.equal(iso.status, 404);
  });

  test('guards see medical flags only through an open SOS', async () => {
    const sos = await api.post('/api/v1/sos').set(H('r1')).send({ type: 'medical', message: 'Grandmother fainted' });
    assert.equal(sos.status, 201, JSON.stringify(sos.body));
    const ctxRes = await api.get(`/api/v1/household/sos-context/${sos.body.data._id}`).set(H('guard'));
    assert.equal(ctxRes.status, 200, JSON.stringify(ctxRes.body));
    const c = ctxRes.body.data;
    assert.equal(c.unit.label, 'A-101');
    assert.equal(c.members[0].elderly, true);
    assert.equal(c.members[0].conditions, 'Diabetic');
    assert.equal(c.residents.find((r) => r.allergies === 'Penicillin').bloodGroup, 'O+');
    assert.equal(c.emergencyContacts[0].phone, '9811100000');
    assert.equal(c.pets[0].name, 'Bruno');
    assert.equal(c.medicalNotes, 'Oxygen cylinder in bedroom');

    assert.equal((await api.get(`/api/v1/household/sos-context/${sos.body.data._id}`).set(H('r3'))).status, 403);
    await api.post(`/api/v1/sos/${sos.body.data._id}/resolve`).set(H('guard')).send({ resolutionNote: 'Ambulance came' });
    const closed = await api.get(`/api/v1/household/sos-context/${sos.body.data._id}`).set(H('guard'));
    assert.equal(closed.status, 403, 'not browsable after the emergency');
    assert.equal((await api.get(`/api/v1/household/sos-context/${sos.body.data._id}`).set(H('fm'))).status, 200);
    const iso = await api.get(`/api/v1/household/sos-context/${sos.body.data._id}`).set(bearer(s.otherAdmin.accessToken));
    assert.equal(iso.status, 404);
  });
});

describe('KYC', () => {
  test('stores only the last 4 Aadhaar digits and never returns the full number', async () => {
    const file = await upload('r1');
    const res = await api.post('/api/v1/kyc').set(H('r1')).send({ type: 'aadhaar', number: '1234 5678 9012', files: [file] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.last4, '9012');
    assert.equal(res.body.data.status, 'pending');
    assert.ok(!JSON.stringify(res.body).includes('123456789012'));
    assert.ok(!JSON.stringify(res.body).includes('1234 5678'));
    const raw = await models.KycDocument.collection.findOne({ last4: '9012' });
    assert.ok(raw && !JSON.stringify(raw).includes('123456789012'), 'full number is not persisted');
    s.aadhaarId = res.body.data._id;

    const mine = await api.get('/api/v1/kyc/me').set(H('r1'));
    assert.ok(!JSON.stringify(mine.body).includes('123456789012'));
    assert.equal(mine.body.data.completion.complete, false);

    const invalid = await api.post('/api/v1/kyc').set(H('r1')).send({ type: 'aadhaar', number: '12345', files: [file] });
    assert.equal(invalid.status, 422);
    const noFile = await api.post('/api/v1/kyc').set(H('r1')).send({ type: 'pan', number: 'ABCDE1234F', files: [] });
    assert.equal(noFile.status, 422);
  });

  test('only the member and admins can see a document', async () => {
    assert.equal((await api.get(`/api/v1/kyc/${s.aadhaarId}`).set(H('r1'))).status, 200);
    assert.equal((await api.get(`/api/v1/kyc/${s.aadhaarId}`).set(H('r3'))).status, 404);
    assert.equal((await api.get(`/api/v1/kyc/${s.aadhaarId}`).set(H('fm'))).status, 404);
    assert.equal((await api.get(`/api/v1/kyc/${s.aadhaarId}`).set(H('admin'))).status, 200);
    assert.equal((await api.get(`/api/v1/kyc/${s.aadhaarId}`).set(bearer(s.otherAdmin.accessToken))).status, 404);
    assert.equal((await api.get('/api/v1/kyc').set(H('fm'))).status, 403, 'facility managers are not KYC reviewers');
    assert.equal((await api.get('/api/v1/kyc/completion').set(H('fm'))).status, 403);
    const queue = await api.get('/api/v1/kyc?status=pending').set(H('admin'));
    assert.equal(queue.body.meta.total, 1);
    assert.equal((await api.get('/api/v1/kyc').set(bearer(s.otherAdmin.accessToken))).body.meta.total, 0);
  });

  test('admin rejects with a reason, member resubmits, admin verifies; completion per unit', async () => {
    const noReason = await api.post(`/api/v1/kyc/${s.aadhaarId}/reject`).set(H('admin')).send({});
    assert.equal(noReason.status, 422);
    const rej = await api.post(`/api/v1/kyc/${s.aadhaarId}/reject`).set(H('admin')).send({ reason: 'Image is blurred' });
    assert.equal(rej.body.data.status, 'rejected');
    assert.equal(rej.body.data.rejectionReason, 'Image is blurred');
    assert.ok((await notesOf('r1')).some((n) => n.type === 'kyc' && n.body === 'Image is blurred'));
    assert.equal((await api.post(`/api/v1/kyc/${s.aadhaarId}/verify`).set(H('r1'))).status, 403);

    const files = { a: await upload('r1'), b: await upload('r1'), photo: await upload('r1'), deed: await upload('r1'), tenant: await upload('t2') };
    const again = await api.post('/api/v1/kyc').set(H('r1')).send({ type: 'aadhaar', number: '9012', files: [files.a] });
    assert.equal(again.status, 201);
    assert.equal(again.body.data._id, s.aadhaarId, 'resubmission replaces the same document');
    assert.equal(again.body.data.status, 'pending');
    const ok1 = await api.post(`/api/v1/kyc/${s.aadhaarId}/verify`).set(H('admin'));
    assert.equal(ok1.body.data.status, 'verified');
    const locked = await api.post('/api/v1/kyc').set(H('r1')).send({ type: 'aadhaar', number: '9012', files: [files.b] });
    assert.equal(locked.status, 409);
    assert.equal((await api.delete(`/api/v1/kyc/${s.aadhaarId}`).set(H('r1'))).status, 409);

    const photo = await api.post('/api/v1/kyc').set(H('r1')).send({ type: 'photo', files: [files.photo] });
    const deed = await api.post('/api/v1/kyc').set(H('r1')).send({ type: 'sale_deed', files: [files.deed] });
    assert.equal(deed.status, 201);
    await api.post(`/api/v1/kyc/${photo.body.data._id}/verify`).set(H('admin'));
    await api.post(`/api/v1/kyc/${deed.body.data._id}/verify`).set(H('admin'));
    const tenantDeed = await api.post('/api/v1/kyc').set(H('t2')).send({ type: 'sale_deed', files: [files.tenant] });
    assert.equal(tenantDeed.status, 403, 'tenants cannot submit ownership documents');

    const me = await api.get('/api/v1/kyc/me').set(H('r1'));
    assert.equal(me.body.data.completion.complete, true);
    const comp = await api.get('/api/v1/kyc/completion').set(H('admin'));
    const a101 = comp.body.data.find((r) => r.unit.label === 'A-101');
    assert.equal(a101.percent, 100);
    assert.equal(a101.complete, true);
    const a102 = comp.body.data.find((r) => r.unit.label === 'A-102');
    assert.equal(a102.required, 5, 'owner needs 3, tenant needs 2');
    assert.equal(a102.done, 0);
    assert.equal(comp.body.meta.summary.completeUnits, 1);
    assert.equal(comp.body.meta.summary.occupiedUnits, 3);
    const incomplete = await api.get('/api/v1/kyc/completion?incompleteOnly=true').set(H('admin'));
    assert.equal(incomplete.body.meta.total, 2);
  });
});

describe('tenancy', () => {
  test('admin records a lease; owner and tenant see it, others do not', async () => {
    const agreement = await upload('admin');
    const bad = await api.post('/api/v1/tenancies').set(H('admin')).send({ unit: s.units['A-102'], tenantMembership: s.o2Membership, startDate: plusDays(-300), endDate: plusDays(20) });
    assert.equal(bad.status, 400, 'an owner is not a tenant');
    const res = await api.post('/api/v1/tenancies').set(H('admin')).send({
      unit: s.units['A-102'],
      tenantMembership: s.t2Membership,
      startDate: plusDays(-300),
      endDate: plusDays(20),
      rent: 2500000,
      agreement: [agreement],
      emergencyContact: { name: 'Tenant Father', phone: '9822200000' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.ownerUser.name, 'o2 person', 'owner is detected from the unit');
    assert.equal(res.body.data.daysLeft, 20);
    assert.equal(res.body.data.agreement.length, 1);
    s.leaseId = res.body.data._id;

    const dup = await api.post('/api/v1/tenancies').set(H('fm')).send({ unit: s.units['A-102'], tenantMembership: s.t2Membership, startDate: plusDays(1), endDate: plusDays(200) });
    assert.equal(dup.status, 409);
    const inverted = await api.post('/api/v1/tenancies').set(H('fm')).send({ unit: s.units['A-103'], tenantMembership: s.t2Membership, startDate: plusDays(10), endDate: plusDays(1) });
    assert.equal(inverted.status, 422);

    assert.equal((await api.get('/api/v1/tenancies').set(H('t2'))).body.meta.total, 1);
    assert.equal((await api.get('/api/v1/tenancies').set(H('o2'))).body.meta.total, 1);
    assert.equal((await api.get('/api/v1/tenancies').set(H('r1'))).body.meta.total, 0);
    assert.equal((await api.get(`/api/v1/tenancies/${s.leaseId}`).set(H('r3'))).status, 404);
    assert.equal((await api.get(`/api/v1/tenancies/${s.leaseId}`).set(bearer(s.otherAdmin.accessToken))).status, 404);
    assert.equal((await api.post('/api/v1/tenancies').set(H('o2')).send({})).status, 403);
    assert.equal((await api.get('/api/v1/tenancies').set(H('guard'))).status, 403);
  });

  test('tenant uploads police verification; manager verifies', async () => {
    const doc = await upload('t2');
    const res = await api.post(`/api/v1/tenancies/${s.leaseId}/documents`).set(H('t2')).send({ kind: 'police', files: [doc], reference: 'PS-778' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.policeVerification.status, 'submitted');
    const v = await api.patch(`/api/v1/tenancies/${s.leaseId}`).set(H('fm')).send({ policeVerification: { status: 'verified' } });
    assert.equal(v.body.data.policeVerification.status, 'verified');
    assert.equal((await api.patch(`/api/v1/tenancies/${s.leaseId}`).set(H('t2')).send({ rent: 1 })).status, 403);
  });

  test('expiry reminders at 30 and 7 days, then a move-out prompt, each sent once', async () => {
    const { expiryReminders } = await import('../src/modules/tenancy/tenancy.service.js');
    const first = await expiryReminders();
    assert.equal(first['30'], 1);
    assert.equal((await expiryReminders())['30'], 0, 'not repeated');
    for (const who of ['t2', 'o2', 'admin']) {
      // eslint-disable-next-line no-await-in-loop
      assert.ok((await notesOf(who)).some((n) => n.type === 'lease' && /ends in 20 days/.test(n.title)), `${who} reminded`);
    }
    assert.ok(!(await notesOf('r1')).some((n) => n.type === 'lease'));

    await models.Lease.updateOne({ _id: s.leaseId }, { endDate: plusDays(5) });
    const week = await expiryReminders();
    assert.equal(week['7'], 1);
    assert.ok((await notesOf('t2')).some((n) => /ends in 5 days/.test(n.title)));

    await models.Lease.updateOne({ _id: s.leaseId }, { endDate: plusDays(-1) });
    const ended = await expiryReminders();
    assert.equal(ended.expired, 1);
    assert.equal((await expiryReminders()).expired, 0);
    assert.ok((await notesOf('admin')).some((n) => /has ended/.test(n.title)));
    const due = await api.get('/api/v1/tenancies?expired=true').set(H('fm'));
    assert.equal(due.body.data[0].moveOutDue, true);
  });

  test('move-out ends the lease, deactivates the tenant (admin only) and keeps history', async () => {
    const fmTry = await api.post(`/api/v1/tenancies/${s.leaseId}/end`).set(H('fm')).send({ reason: 'Lease over', moveOut: true });
    assert.equal(fmTry.status, 403);
    const res = await api.post(`/api/v1/tenancies/${s.leaseId}/end`).set(H('admin')).send({ reason: 'Lease over', moveOut: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'ended');
    assert.equal(res.body.data.movedOut, true);
    const m = await models.Membership.findById(s.t2Membership).lean();
    assert.equal(m.status, 'inactive');
    const hist = await api.get(`/api/v1/tenancies/units/${s.units['A-102']}/history`).set(H('o2'));
    assert.equal(hist.status, 200);
    assert.equal(hist.body.data.leases.length, 1);
    assert.equal((await api.get(`/api/v1/tenancies/units/${s.units['A-102']}/history`).set(H('r1'))).status, 403);
    assert.equal((await api.post(`/api/v1/tenancies/${s.leaseId}/end`).set(H('admin')).send({ reason: 'again' })).status, 409);
  });
});

describe('daily help upgrades', () => {
  test('ratings by households give an average; only linked homes may rate', async () => {
    const a = await api.post('/api/v1/daily-help').set(H('r1')).send({ name: 'Sunita', phone: '9876500000', type: 'maid' });
    assert.equal(a.status, 201);
    s.helpId = a.body.data._id;
    const linked = await api.post('/api/v1/daily-help').set(H('o2')).send({ name: 'Sunita', phone: '9876500000' });
    assert.equal(linked.body.data._id, s.helpId);

    const r1 = await api.put(`/api/v1/daily-help/${s.helpId}/reviews/mine`).set(H('r1')).send({ rating: 5, text: 'Very punctual' });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const o2 = await api.put(`/api/v1/daily-help/${s.helpId}/reviews/mine`).set(H('o2')).send({ rating: 2 });
    assert.equal(o2.body.data.avgRating, 3.5);
    assert.equal(o2.body.data.ratingCount, 2);
    const again = await api.put(`/api/v1/daily-help/${s.helpId}/reviews/mine`).set(H('o2')).send({ rating: 4 });
    assert.equal(again.body.data.avgRating, 4.5, 'a household re-rating replaces its review');
    assert.equal(again.body.data.ratingCount, 2);
    assert.equal((await api.put(`/api/v1/daily-help/${s.helpId}/reviews/mine`).set(H('r3')).send({ rating: 1 })).status, 404);
    assert.equal((await api.put(`/api/v1/daily-help/${s.helpId}/reviews/mine`).set(H('r1')).send({ rating: 6 })).status, 422);

    const list = await api.get('/api/v1/daily-help').set(H('r1'));
    const sunita = list.body.data.find((h) => h._id === s.helpId);
    assert.equal(sunita.avgRating, 4.5);
    assert.equal(sunita.myReview.rating, 5);
    const reviews = await api.get(`/api/v1/daily-help/${s.helpId}/reviews`).set(H('fm'));
    assert.equal(reviews.body.data.length, 2);
  });

  test('salary reminder job reminds once per month until paid', async () => {
    const { salaryReminders } = await import('../src/modules/dailyHelp/dailyHelp.service.js');
    const set = await api.put(`/api/v1/daily-help/${s.helpId}/employment`).set(H('r1')).send({ salary: 500000, dueDay: 1 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal((await api.put(`/api/v1/daily-help/${s.helpId}/employment`).set(H('r3')).send({ salary: 1 })).status, 404);
    const first = await salaryReminders();
    assert.equal(first.reminded, 1);
    assert.equal((await salaryReminders()).reminded, 0);
    assert.ok((await notesOf('r1')).some((n) => /Salary due for Sunita/.test(n.title) && n.body.includes('5,000')));
    assert.ok(!(await notesOf('o2')).some((n) => /Salary due/.test(n.title)), 'other household is not told about r1\'s salary');
    const mine = await api.get('/api/v1/daily-help').set(H('o2'));
    assert.equal(mine.body.data[0].myEmployment, null, 'salary details are private to the household');

    const paid = await api.post(`/api/v1/daily-help/${s.helpId}/salary-paid`).set(H('r1')).send({});
    assert.equal(paid.body.data.lastPaidPeriod, IST().slice(0, 7));
  });

  test('households mark leave; other linked homes are told', async () => {
    const res = await api.post(`/api/v1/daily-help/${s.helpId}/leaves`).set(H('o2')).send({ date: IST(), kind: 'leave', reason: 'Village visit' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok((await notesOf('r1')).some((n) => /Sunita is on leave today/.test(n.title)));
    assert.equal((await api.post(`/api/v1/daily-help/${s.helpId}/leaves`).set(H('o2')).send({ date: IST() })).status, 409);
    const leaves = await api.get(`/api/v1/daily-help/${s.helpId}/leaves`).set(H('o2'));
    assert.equal(leaves.body.meta.total, 1);
    assert.equal((await api.get(`/api/v1/daily-help/${s.helpId}/leaves`).set(H('r1'))).body.meta.total, 0, 'another home\'s leave entry is private');
    await api.delete(`/api/v1/daily-help/${s.helpId}/leaves/${res.body.data._id}`).set(H('o2')).expect(204);
  });

  test('auto-absent job after noon notifies linked households once', async () => {
    const { autoAbsent } = await import('../src/modules/dailyHelp/dailyHelp.service.js');
    const today = IST();
    const noon = new Date(`${today}T13:00:00+05:30`);
    const morning = new Date(`${today}T09:00:00+05:30`);
    await models.DailyHelp.updateOne({ _id: s.helpId }, { lastSeenAt: new Date(`${today}T08:00:00+05:30`).getTime() - 86400000, isInside: false });
    assert.equal((await autoAbsent(morning)).skipped, true);
    const run = await autoAbsent(noon);
    assert.equal(run.absent, 1);
    assert.equal((await autoAbsent(noon)).absent, 0, 'once per day');
    assert.ok((await notesOf('o2')).some((n) => /Sunita is absent today/.test(n.title)));
    const list = await api.get('/api/v1/daily-help').set(H('r1'));
    assert.equal(list.body.data.find((h) => h._id === s.helpId).awayToday.source, 'auto');

    // A regular helper with a gate entry today is not marked absent
    const other = await api.post('/api/v1/daily-help').set(H('r3')).send({ name: 'Ramesh', phone: '9876511111', type: 'driver' });
    await models.DailyHelp.updateOne({ _id: other.body.data._id }, { lastSeenAt: new Date(new Date(`${today}T08:00:00+05:30`).getTime() - 86400000) });
    await models.HelpAttendance.create({ society: s.admin.user.society._id, help: other.body.data._id, inAt: new Date(`${today}T08:30:00+05:30`), outAt: new Date(`${today}T10:00:00+05:30`) });
    assert.equal((await autoAbsent(noon)).absent, 0);
    assert.ok(!(await notesOf('r3')).some((n) => /Ramesh is absent/.test(n.title)));
  });

  test('helper documents and police verification; guards never get documents', async () => {
    const file = await upload('r1');
    const res = await api.post(`/api/v1/daily-help/${s.helpId}/documents`).set(H('r1')).send({ kind: 'police_verification', files: [file] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.policeVerification.status, 'submitted');
    assert.equal(res.body.data.documents.length, 1);
    assert.equal((await api.post(`/api/v1/daily-help/${s.helpId}/verification`).set(H('r1')).send({ status: 'verified' })).status, 403);
    const v = await api.post(`/api/v1/daily-help/${s.helpId}/verification`).set(H('fm')).send({ status: 'verified', notes: 'Cleared by PS' });
    assert.equal(v.body.data.policeVerification.status, 'verified');
    const guardView = await api.get('/api/v1/daily-help').set(H('guard'));
    const g = guardView.body.data.find((h) => h._id === s.helpId);
    assert.equal(g.documents, undefined);
    assert.equal(g.policeVerification.status, 'verified');
  });
});

describe('amenity payments, deposits and cancellation policy', () => {
  test('paid booking is held until the gateway payment is verified', async () => {
    const hall = await api.post('/api/v1/amenities').set(H('fm')).send({
      name: 'Banquet', capacity: 1, openTime: '09:00', closeTime: '21:00', slotMinutes: 120, fee: 100000, deposit: 200000,
      maxBookingsPerUnitPerDay: 5, paymentMode: 'online', cancellation: { fullRefundHours: 24, partialRefundHours: 6, partialRefundPercent: 50 },
    });
    assert.equal(hall.status, 201, JSON.stringify(hall.body));
    s.hall = hall.body.data._id;
    const photo = await upload('fm', 'amenities');
    const withPhoto = await api.post(`/api/v1/amenities/${s.hall}/photos`).set(H('fm')).send({ files: [photo] });
    assert.equal(withPhoto.body.data.photos.length, 1);

    s.day = plusDays(3);
    const b = await api.post('/api/v1/bookings').set(H('r1')).send({ amenity: s.hall, date: s.day, startTime: '09:00', endTime: '11:00' });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(b.body.data.status, 'payment_pending');
    assert.equal(b.body.data.fee, 100000);
    assert.equal(b.body.data.deposit, 200000);
    s.paidBooking = b.body.data._id;
    const avail = await api.get(`/api/v1/amenities/${s.hall}/availability?date=${s.day}`).set(H('r3'));
    assert.equal(avail.body.data.slots[0].available, 0, 'slot held while paying');

    const order = await api.post(`/api/v1/bookings/${s.paidBooking}/pay`).set(H('r1'));
    assert.equal(order.status, 200, JSON.stringify(order.body));
    assert.equal(order.body.data.amount, 300000);
    const forged = await api.post('/api/v1/amenities/payments/verify').set(H('r1')).send({ orderId: order.body.data.orderId, paymentId: 'mock_pay_x1', signature: 'deadbeefdeadbeef' });
    assert.equal(forged.status, 400);
    assert.equal((await models.Booking.findById(s.paidBooking).lean()).status, 'payment_pending');
    assert.equal((await api.post(`/api/v1/bookings/${s.paidBooking}/pay`).set(H('r3'))).status, 404, 'only the booker pays');

    const order2 = await api.post(`/api/v1/bookings/${s.paidBooking}/pay`).set(H('r1'));
    const signed = await sign(order2.body.data.orderId);
    assert.equal((await api.post('/api/v1/amenities/payments/verify').set(H('r3')).send(signed)).status, 404, 'someone else cannot settle it');
    const ok1 = await api.post('/api/v1/amenities/payments/verify').set(H('r1')).send(signed);
    assert.equal(ok1.status, 200, JSON.stringify(ok1.body));
    assert.equal(ok1.body.data.booking.status, 'confirmed');
    assert.equal(ok1.body.data.booking.paymentStatus, 'paid');
    assert.equal(ok1.body.data.booking.depositStatus, 'held');
    const replay = await api.post('/api/v1/amenities/payments/verify').set(H('r1')).send(signed);
    assert.equal(replay.status, 200, 'idempotent');

    const pays = await models.AmenityPayment.find({ booking: s.paidBooking, status: 'success' }).lean();
    assert.deepEqual(pays.map((p) => p.kind).sort(), ['deposit', 'fee']);
    assert.equal(pays.find((p) => p.kind === 'fee').amount, 100000);
    assert.ok(pays.every((p) => p.provider === 'mock' && p.providerPaymentId && p.paidAt && String(p.unit) === s.units['A-101']));
  });

  test('cancellation refund policy: full, partial and none; deposit always returned', async () => {
    const book = async (startTime, endTime) => {
      const b = await api.post('/api/v1/bookings').set(H('r1')).send({ amenity: s.hall, date: s.day, startTime, endTime });
      assert.equal(b.status, 201, JSON.stringify(b.body));
      const o = await api.post(`/api/v1/bookings/${b.body.data._id}/pay`).set(H('r1'));
      await api.post('/api/v1/amenities/payments/verify').set(H('r1')).send(await sign(o.body.data.orderId)).expect(200);
      return b.body.data._id;
    };
    const moveTo = async (id, hoursAhead) => {
      const at = new Date(Date.now() + hoursAhead * 3600000);
      await models.Booking.updateOne({ _id: id }, { date: IST(at), startTime: istTime(at), endTime: istTime(at) });
    };

    const full = await book('11:00', '13:00');
    const q = await api.get(`/api/v1/bookings/${full}/cancellation-quote`).set(H('r1'));
    assert.equal(q.body.data.percent, 100);
    const c1 = await api.post(`/api/v1/bookings/${full}/cancel`).set(H('r1')).send({});
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    assert.equal(c1.body.data.refund.feeRefunded, 100000);
    assert.equal(c1.body.data.refund.depositRefunded, 200000);
    assert.equal(c1.body.data.paymentStatus, 'refunded');
    const refunded = await models.AmenityPayment.find({ booking: full }).lean();
    assert.ok(refunded.filter((p) => p.status === 'refunded').length === 2 && refunded.every((p) => p.status !== 'success'));
    assert.equal((await api.post(`/api/v1/bookings/${full}/cancel`).set(H('r1')).send({})).status, 404, 'no double refund');

    const partial = await book('13:00', '15:00');
    await moveTo(partial, 10);
    const c2 = await api.post(`/api/v1/bookings/${partial}/cancel`).set(H('r1')).send({});
    assert.equal(c2.body.data.refund.percent, 50);
    assert.equal(c2.body.data.refund.feeRefunded, 50000);
    assert.equal(c2.body.data.refund.depositRefunded, 200000);
    assert.equal(c2.body.data.paymentStatus, 'partially_refunded');
    const feeRec = await models.AmenityPayment.findOne({ booking: partial, kind: 'fee' }).lean();
    assert.equal(feeRec.refundedAmount, 50000);
    assert.equal(feeRec.status, 'refunded');

    const late = await book('15:00', '17:00');
    await moveTo(late, 2);
    const c3 = await api.post(`/api/v1/bookings/${late}/cancel`).set(H('r1')).send({});
    assert.equal(c3.body.data.refund.feeRefunded, 0);
    assert.equal(c3.body.data.refund.depositRefunded, 200000);

    // A manager cancelling refunds everything regardless of timing
    const byFm = await book('17:00', '19:00');
    await moveTo(byFm, 1);
    const c4 = await api.post(`/api/v1/bookings/${byFm}/cancel`).set(H('fm')).send({ reason: 'Maintenance' });
    assert.equal(c4.body.data.refund.feeRefunded, 100000);
    assert.ok((await notesOf('r1')).some((n) => /Booking cancelled: Banquet/.test(n.title)));
  });

  test('deposit is refunded by the manager after the event, with deductions', async () => {
    const early = await api.post(`/api/v1/bookings/${s.paidBooking}/refund-deposit`).set(H('fm')).send({});
    assert.equal(early.status, 409, 'not before the event ends');
    await models.Booking.updateOne({ _id: s.paidBooking }, { date: plusDays(-1) });
    assert.equal((await api.post(`/api/v1/bookings/${s.paidBooking}/refund-deposit`).set(H('r1')).send({})).status, 403);
    const tooMuch = await api.post(`/api/v1/bookings/${s.paidBooking}/refund-deposit`).set(H('fm')).send({ amount: 300000 });
    assert.equal(tooMuch.status, 400);
    const noReason = await api.post(`/api/v1/bookings/${s.paidBooking}/refund-deposit`).set(H('fm')).send({ amount: 150000 });
    assert.equal(noReason.status, 400);
    const res = await api.post(`/api/v1/bookings/${s.paidBooking}/refund-deposit`).set(H('fm')).send({ amount: 150000, reason: 'Broken chair' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.depositStatus, 'partially_refunded');
    assert.equal(res.body.data.depositRefunded, 150000);
    const dep = await models.AmenityPayment.findOne({ booking: s.paidBooking, kind: 'deposit', status: { $ne: 'failed' } }).lean();
    assert.equal(dep.refundedAmount, 150000);
    assert.equal(dep.status, 'refunded');
    assert.ok(dep.refundedAt);
    assert.equal((await api.post(`/api/v1/bookings/${s.paidBooking}/refund-deposit`).set(H('fm')).send({})).status, 409);
    const att = await api.post(`/api/v1/bookings/${s.paidBooking}/attendance`).set(H('fm')).send({ attended: false });
    assert.equal(att.body.data.attendance, 'no_show');
  });

  test('pay-at-desk amenities confirm at once; lapsed online holds release the slot', async () => {
    const court = await api.post('/api/v1/amenities').set(H('fm')).send({ name: 'Tennis', capacity: 1, openTime: '06:00', closeTime: '22:00', slotMinutes: 60, fee: 20000, paymentMode: 'desk' });
    const b = await api.post('/api/v1/bookings').set(H('r3')).send({ amenity: court.body.data._id, date: plusDays(1), startTime: '07:00', endTime: '08:00' });
    assert.equal(b.body.data.status, 'confirmed');
    assert.equal(b.body.data.paymentStatus, 'pay_at_desk');
    const paid = await api.post(`/api/v1/bookings/${b.body.data._id}/mark-paid`).set(H('fm')).send({ method: 'upi', reference: 'UPI123' });
    assert.equal(paid.body.data.paymentStatus, 'paid');
    assert.equal((await models.AmenityPayment.findOne({ booking: b.body.data._id }).lean()).method, 'upi');

    const { expireHolds } = await import('../src/modules/amenities/amenities.service.js');
    const hold = await api.post('/api/v1/bookings').set(H('r3')).send({ amenity: s.hall, date: plusDays(4), startTime: '09:00', endTime: '11:00' });
    assert.equal(hold.body.data.status, 'payment_pending');
    const r = await expireHolds(new Date(Date.now() + 20 * 60000));
    assert.ok(r.expired >= 1);
    assert.equal((await models.Booking.findById(hold.body.data._id).lean()).status, 'cancelled');
    const again = await api.post('/api/v1/bookings').set(H('r1')).send({ amenity: s.hall, date: plusDays(4), startTime: '09:00', endTime: '11:00' });
    assert.equal(again.status, 201, 'slot is free again');
  });

  test('approval amenities ask for payment after approval', async () => {
    const club = await api.post('/api/v1/amenities').set(H('fm')).send({ name: 'Clubhouse', capacity: 1, openTime: '09:00', closeTime: '21:00', slotMinutes: 180, fee: 50000, requiresApproval: true });
    const b = await api.post('/api/v1/bookings').set(H('r1')).send({ amenity: club.body.data._id, date: plusDays(5), startTime: '09:00', endTime: '12:00' });
    assert.equal(b.body.data.status, 'pending');
    assert.equal((await api.post(`/api/v1/bookings/${b.body.data._id}/pay`).set(H('r1'))).status, 409);
    const d = await api.post(`/api/v1/bookings/${b.body.data._id}/decide`).set(H('fm')).send({ approve: true });
    assert.equal(d.body.data.status, 'payment_pending');
    const o = await api.post(`/api/v1/bookings/${b.body.data._id}/pay`).set(H('r1'));
    const v = await api.post('/api/v1/amenities/payments/verify').set(H('r1')).send(await sign(o.body.data.orderId));
    assert.equal(v.body.data.booking.status, 'confirmed');
  });

  test('defaulters are blocked from booking when the finance setting is on', async () => {
    const bill = await models.Bill.create({ society: s.admin.user.society._id, unit: s.units['A-103'], period: '2026-01', billNumber: 'BILL-TEST-1', amount: 100000, total: 100000, dueDate: new Date(Date.now() - 5 * 86400000) });
    const gym = await api.post('/api/v1/amenities').set(H('fm')).send({ name: 'Gym', capacity: 10, openTime: '05:00', closeTime: '23:00', slotMinutes: 60 });
    s.gym = gym.body.data._id;
    const allowed = await api.post('/api/v1/bookings').set(H('r3')).send({ amenity: s.gym, date: plusDays(1), startTime: '06:00', endTime: '07:00' });
    assert.equal(allowed.status, 201, 'setting off: not blocked');

    const { default: FinanceSettings } = await import('../src/modules/financeSettings/financeSettings.model.js');
    await FinanceSettings.updateOne({ society: s.admin.user.society._id }, { $set: { restrictAmenityForDefaulters: true } }, { upsert: true });
    const blocked = await api.post('/api/v1/bookings').set(H('r3')).send({ amenity: s.gym, date: plusDays(2), startTime: '06:00', endTime: '07:00' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'DUES_PENDING');
    const fine = await api.post('/api/v1/bookings').set(H('r1')).send({ amenity: s.gym, date: plusDays(2), startTime: '06:00', endTime: '07:00' });
    assert.equal(fine.status, 201, 'units without overdue dues still book');

    await models.Bill.updateOne({ _id: bill._id }, { status: 'paid', paid: 100000 });
    const after = await api.post('/api/v1/bookings').set(H('r3')).send({ amenity: s.gym, date: plusDays(2), startTime: '08:00', endTime: '09:00' });
    assert.equal(after.status, 201, 'unblocked once dues are cleared');
    await FinanceSettings.updateOne({ society: s.admin.user.society._id }, { $set: { restrictAmenityForDefaulters: false } });
  });
});

describe('amenity passes', () => {
  test('paid pass, QR code check at the door and validity', async () => {
    const plan = await api.post(`/api/v1/amenities/${s.gym}/pass-plans`).set(H('fm')).send({ name: 'Monthly', durationDays: 30, price: 50000 });
    assert.equal(plan.status, 201, JSON.stringify(plan.body));
    assert.equal((await api.post(`/api/v1/amenities/${s.gym}/pass-plans`).set(H('r1')).send({ name: 'X', durationDays: 1, price: 0 })).status, 403);
    const plans = await api.get(`/api/v1/amenities/${s.gym}/pass-plans`).set(H('r1'));
    assert.equal(plans.body.data.length, 1);

    const pass = await api.post('/api/v1/amenity-passes').set(H('r1')).send({ plan: plan.body.data._id });
    assert.equal(pass.status, 201, JSON.stringify(pass.body));
    assert.equal(pass.body.data.status, 'payment_pending');
    assert.equal(pass.body.data.validFrom, IST());
    assert.equal(pass.body.data.validTo, plusDays(29));
    const code = pass.body.data.code;

    const pending = await api.post('/api/v1/amenity-passes/check').set(H('guard')).send({ code });
    assert.equal(pending.body.data.valid, false);
    assert.equal(pending.body.data.reason, 'Payment pending');

    const o = await api.post(`/api/v1/amenity-passes/${pass.body.data._id}/pay`).set(H('r1'));
    assert.equal(o.body.data.amount, 50000);
    const v = await api.post('/api/v1/amenities/payments/verify').set(H('r1')).send(await sign(o.body.data.orderId));
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.data.pass.status, 'active');
    const rec = await models.AmenityPayment.findOne({ pass: pass.body.data._id }).lean();
    assert.equal(rec.kind, 'fee');
    assert.equal(rec.status, 'success');

    const ok1 = await api.post('/api/v1/amenity-passes/check').set(H('guard')).send({ code: code.toLowerCase() });
    assert.equal(ok1.body.data.valid, true);
    assert.equal(ok1.body.data.pass.entries, 1);
    assert.equal(ok1.body.data.pass.holder.name, 'r1 person');
    const wrongPlace = await api.post('/api/v1/amenity-passes/check').set(H('fm')).send({ code, amenity: s.hall });
    assert.equal(wrongPlace.body.data.valid, false);
    assert.equal((await api.post('/api/v1/amenity-passes/check').set(H('r1')).send({ code })).status, 403);
    const unknown = await api.post('/api/v1/amenity-passes/check').set(H('guard')).send({ code: 'ZZZZZZZZ' });
    assert.equal(unknown.body.data.valid, false);
    const iso = await api.post('/api/v1/amenity-passes/check').set(bearer(s.otherAdmin.accessToken)).send({ code });
    assert.equal(iso.body.data.valid, false, 'another society cannot use the code');

    const overlap = await api.post('/api/v1/amenity-passes').set(H('r1')).send({ plan: plan.body.data._id, validFrom: plusDays(10) });
    assert.equal(overlap.status, 409);
    const foreignHolder = await api.post('/api/v1/amenity-passes').set(H('r1')).send({ plan: plan.body.data._id, holder: s.r3.user._id });
    assert.equal(foreignHolder.status, 400);

    await models.AmenityPass.updateOne({ _id: pass.body.data._id }, { validTo: plusDays(-1) });
    const expired = await api.post('/api/v1/amenity-passes/check').set(H('guard')).send({ code });
    assert.equal(expired.body.data.valid, false);
    assert.match(expired.body.data.reason, /Expired/);
    const { expirePasses } = await import('../src/modules/amenities/passes.service.js');
    assert.equal((await expirePasses()).expired, 1);

    const future = await api.post('/api/v1/amenity-passes').set(H('r1')).send({ plan: plan.body.data._id, validFrom: plusDays(3) });
    assert.equal(future.status, 201);
    await api.post(`/api/v1/amenity-passes/${future.body.data._id}/mark-paid`).set(H('fm')).send({ method: 'cash' }).expect(200);
    const notYet = await api.post('/api/v1/amenity-passes/check').set(H('guard')).send({ code: future.body.data.code });
    assert.match(notYet.body.data.reason, /Valid from/);
    assert.equal((await api.get('/api/v1/amenity-passes').set(H('r3'))).body.meta.total, 0);
    assert.equal((await api.get('/api/v1/amenity-passes').set(H('r1'))).body.meta.total, 2);
  });
});

describe('amenity reports', () => {
  test('usage & revenue per amenity with Excel export', async () => {
    const res = await api.get(`/api/v1/amenities/reports/usage?from=${plusDays(-2)}&to=${plusDays(6)}`).set(H('fm'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const hall = res.body.data.rows.find((r) => r.amenity.name === 'Banquet');
    // fees: paid booking 1000 + partial (500 kept) + late (1000 kept) + approved clubhouse is another amenity
    assert.equal(hall.feeRevenue, 100000 + 50000 + 100000);
    assert.equal(hall.noShows, 1);
    assert.equal(hall.depositsHeld, 50000, 'deduction kept from the refunded deposit');
    assert.ok(hall.cancelled >= 4);
    assert.ok(hall.utilisationPercent > 0);
    const gym = res.body.data.rows.find((r) => r.amenity.name === 'Gym');
    assert.equal(gym.bookings, 3);
    assert.equal(gym.activePasses, 1);
    assert.equal((await api.get('/api/v1/amenities/reports/usage').set(H('r1'))).status, 403);

    const xlsx = await api.get('/api/v1/amenities/reports/usage.xlsx').set(H('admin')).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers['content-type'], /spreadsheetml/);
    assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK', 'a zip (xlsx) file');
  });
});

describe('helpdesk upgrades', () => {
  test('custom categories, admin-only management and keyword suggestion', async () => {
    const list = await api.get('/api/v1/complaints/categories').set(H('r1'));
    assert.ok(list.body.data.some((c) => c.key === 'plumbing' && c.isDefault));
    assert.equal((await api.post('/api/v1/complaints/categories').set(H('fm')).send({ name: 'Pest Control' })).status, 403);
    const pest = await api.post('/api/v1/complaints/categories').set(H('admin')).send({ name: 'Pest Control', keywords: ['termite', 'termites', 'rodent'] });
    assert.equal(pest.status, 201, JSON.stringify(pest.body));
    assert.equal(pest.body.data.key, 'pest_control');
    assert.equal((await api.post('/api/v1/complaints/categories').set(H('admin')).send({ name: 'pest control' })).status, 409);

    const sug = await api.get('/api/v1/complaints/categories/suggest').query({ title: 'Termites in the kitchen cupboard' }).set(H('r1'));
    assert.equal(sug.body.data.category, 'pest_control');
    const tap = await api.get('/api/v1/complaints/categories/suggest').query({ title: 'Kitchen tap leaking badly' }).set(H('r1'));
    assert.equal(tap.body.data.category, 'plumbing');
    const none = await api.get('/api/v1/complaints/categories/suggest').query({ title: 'Hello there' }).set(H('r1'));
    assert.equal(none.body.data.category, null);

    const c = await api.post('/api/v1/complaints').set(H('r1')).send({ category: 'pest_control', title: 'Termites in door frame' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.data.categoryName, 'Pest Control');
    const unknown = await api.post('/api/v1/complaints').set(H('r1')).send({ category: 'astrology', title: 'Bad stars' });
    assert.equal(unknown.status, 400);
    await api.patch('/api/v1/complaints/categories/pest_control').set(H('admin')).send({ active: false }).expect(200);
    assert.equal((await api.post('/api/v1/complaints').set(H('r1')).send({ category: 'pest_control', title: 'More termites' })).status, 400);
    assert.equal((await api.patch('/api/v1/complaints/categories/other').set(H('admin')).send({ active: false })).status, 400);
  });

  test('before/after photos are required to resolve selected categories', async () => {
    const set = await api.patch('/api/v1/complaints/categories/plumbing').set(H('admin')).send({ requiresResolutionPhotos: true, keywords: ['seepage'] });
    assert.equal(set.body.data.requiresResolutionPhotos, true);
    assert.ok(set.body.data.keywords.includes('tap') && set.body.data.keywords.includes('seepage'));

    const c = await api.post('/api/v1/complaints').set(H('r1')).send({ category: 'plumbing', priority: 'high', title: 'Bathroom tap leaking' });
    s.plumbing = c.body.data._id;
    assert.equal(c.body.data.requiresResolutionPhotos, true);
    await api.post(`/api/v1/complaints/${s.plumbing}/assign`).set(H('fm')).send({ assignedTo: s.staff.user._id }).expect(200);
    const noPhotos = await api.post(`/api/v1/complaints/${s.plumbing}/status`).set(H('staff')).send({ status: 'resolved' });
    assert.equal(noPhotos.status, 422);
    assert.deepEqual(noPhotos.body.error.details.map((d) => d.field).sort(), ['body.afterPhotos', 'body.beforePhotos']);
    const before = await upload('staff', 'complaints');
    await api.post(`/api/v1/complaints/${s.plumbing}/status`).set(H('staff')).send({ status: 'in_progress', beforePhotos: [before] }).expect(200);
    const onlyBefore = await api.post(`/api/v1/complaints/${s.plumbing}/status`).set(H('staff')).send({ status: 'resolved' });
    assert.equal(onlyBefore.status, 422);
    const afterPhoto = await upload('staff', 'complaints');
    const ok1 = await api.post(`/api/v1/complaints/${s.plumbing}/status`).set(H('staff')).send({ status: 'resolved', afterPhotos: [afterPhoto] });
    assert.equal(ok1.status, 200, JSON.stringify(ok1.body));
    assert.equal(ok1.body.data.resolutionPhotos.before.length, 1);
    assert.equal(ok1.body.data.resolutionPhotos.after.length, 1);
    await api.post(`/api/v1/complaints/${s.plumbing}/rate`).set(H('r1')).send({ rating: 4 }).expect(200);

    // Categories without the rule resolve without photos
    const e = await api.post('/api/v1/complaints').set(H('r1')).send({ category: 'electrical', title: 'Corridor light fused' });
    await api.post(`/api/v1/complaints/${e.body.data._id}/assign`).set(H('fm')).send({ assignedTo: s.staff.user._id });
    await api.post(`/api/v1/complaints/${e.body.data._id}/status`).set(H('staff')).send({ status: 'resolved' }).expect(200);
    s.electrical = e.body.data._id;
  });

  test('escalation matrix: levels by time past SLA, configurable per category', async () => {
    const { runEscalations } = await import('../src/modules/complaints/helpdesk.service.js');
    assert.equal((await api.post('/api/v1/complaints/escalation-rules').set(H('r1')).send({})).status, 403);
    const badOrder = await api.post('/api/v1/complaints/escalation-rules').set(H('fm')).send({ category: 'lift', levels: [{ level: 1, afterHours: 5, roles: ['facility_manager'] }, { level: 2, afterHours: 2, roles: ['admin'] }] });
    assert.equal(badOrder.status, 400);
    const rule = await api.post('/api/v1/complaints/escalation-rules').set(H('fm')).send({
      category: 'lift',
      levels: [
        { level: 1, afterHours: 0, roles: ['facility_manager'], notifyAssignee: true },
        { level: 2, afterHours: 2, roles: ['admin'] },
        { level: 3, afterHours: 5, roles: [], users: [s.r3.user._id] },
      ],
    });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));
    const dup = await api.post('/api/v1/complaints/escalation-rules').set(H('fm')).send({ category: 'lift', levels: [{ level: 1, afterHours: 0, roles: ['admin'] }] });
    assert.equal(dup.status, 409);

    const c = await api.post('/api/v1/complaints').set(H('r1')).send({ category: 'lift', priority: 'urgent', title: 'Lift stuck between floors' });
    const id = c.body.data._id;
    const breach = (hours) => models.Complaint.updateOne({ _id: id }, { slaDueAt: new Date(Date.now() - hours * 3600000) });

    assert.equal((await models.Complaint.findById(id).lean()).escalationLevel, 0);
    await breach(1);
    await runEscalations();
    assert.equal((await models.Complaint.findById(id).lean()).escalationLevel, 1);
    assert.ok((await notesOf('fm')).some((n) => n.title === `Escalation L1: ${c.body.data.ticketNumber}`));
    assert.ok(!(await notesOf('admin')).some((n) => n.title.startsWith(`Escalation L1: ${c.body.data.ticketNumber}`)), 'admin is level 2');
    await runEscalations();
    assert.equal((await models.Complaint.findById(id).lean()).escalations.length, 1, 'each level once');

    await breach(3);
    await runEscalations();
    assert.equal((await models.Complaint.findById(id).lean()).escalationLevel, 2);
    assert.ok((await notesOf('admin')).some((n) => n.title === `Escalation L2: ${c.body.data.ticketNumber}`));

    await breach(6);
    await runEscalations();
    const top = await models.Complaint.findById(id).lean();
    assert.equal(top.escalationLevel, 3);
    assert.ok((await notesOf('r3')).some((n) => n.title === `Escalation L3: ${c.body.data.ticketNumber}`), 'named user at level 3');
    const view = await api.get(`/api/v1/complaints/${id}`).set(H('fm'));
    assert.deepEqual(view.body.data.history.filter((h) => h.kind === 'escalation').map((h) => h.level), [1, 2, 3]);

    // Without a rule the built-in matrix applies (L1 at breach, L2 at +24h): a long-overdue ticket jumps to L2.
    const w = await api.post('/api/v1/complaints').set(H('r1')).send({ category: 'water', title: 'No water since morning' });
    await models.Complaint.updateOne({ _id: w.body.data._id }, { slaDueAt: new Date(Date.now() - 30 * 3600000) });
    await runEscalations();
    const water = await models.Complaint.findById(w.body.data._id).lean();
    assert.equal(water.escalationLevel, 2);
    assert.equal(water.escalations.length, 1);

    // Reopening restarts the ladder
    await models.Complaint.updateOne({ _id: id }, { status: 'resolved' });
    await api.post(`/api/v1/complaints/${id}/reopen`).set(H('r1')).send({ note: 'Stuck again' }).expect(200);
    assert.equal((await models.Complaint.findById(id).lean()).escalationLevel, 0);

    const rules = await api.get('/api/v1/complaints/escalation-rules').set(H('fm'));
    assert.equal(rules.body.data.rules.length, 1);
    assert.equal(rules.body.data.defaults.length, 3);
    await api.delete(`/api/v1/complaints/escalation-rules/${rule.body.data._id}`).set(H('fm')).expect(204);
    assert.equal((await api.delete(`/api/v1/complaints/escalation-rules/${rule.body.data._id}`).set(bearer(s.otherAdmin.accessToken))).status, 404);
  });

  test('staff performance report numbers', async () => {
    // Staff: plumbing (resolved in time, rated 4), electrical (resolved, late). Lift ticket stays open with FM.
    const oid = (await import('mongoose')).default.Types.ObjectId;
    await models.Complaint.collection.updateOne({ _id: new oid(s.electrical) }, { $set: { slaDueAt: new Date(Date.now() - 3600000), resolvedAt: new Date(), createdAt: new Date(Date.now() - 10 * 3600000) } });
    await models.Complaint.collection.updateOne({ _id: new oid(s.plumbing) }, { $set: { createdAt: new Date(Date.now() - 4 * 3600000) } });
    const res = await api.get('/api/v1/complaints/reports/staff-performance').set(H('fm'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = res.body.data.rows.find((r) => r.user._id === s.staff.user._id);
    assert.equal(row.assigned, 2);
    assert.equal(row.resolved, 2);
    assert.equal(row.slaMetPercent, 50);
    assert.equal(row.avgRating, 4);
    assert.ok(row.avgResolutionHours >= 6.9 && row.avgResolutionHours <= 7.1, `avg ${row.avgResolutionHours}`);
    assert.equal(row.user.role, 'staff');
    assert.equal((await api.get('/api/v1/complaints/reports/staff-performance').set(H('staff'))).status, 403);
    const other = await api.get('/api/v1/complaints/reports/staff-performance').set(bearer(s.otherAdmin.accessToken));
    assert.equal(other.body.data.rows.length, 0);
  });
});
