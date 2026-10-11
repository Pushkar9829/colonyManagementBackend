// Accounting (double-entry ledger, sync, reports, bank reconciliation, budget) and
// expenses (vendors, purchase requests, vendor bills/payments, recurring) integration tests.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const dmy = (iso) => iso.split('-').reverse().join('/');
const V1 = '/api/v1';

const login = async (identifier, password = 'Password@123') => {
  const res = await api.post(`${V1}/auth/login`).send({ identifier, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const as = (who) => bearer(s[who].accessToken);
const get = (who, path, query) => api.get(`${V1}${path}`).query(query || {}).set(as(who));
const post = (who, path, body) => api.post(`${V1}${path}`).set(as(who)).send(body ?? {});
const patch = (who, path, body) => api.patch(`${V1}${path}`).set(as(who)).send(body);
const put = (who, path, body) => api.put(`${V1}${path}`).set(as(who)).send(body);
const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data;
};

async function balanceOf(who, code, asOf) {
  const accounts = ok(await get(who, '/accounting/accounts', { withBalances: 'true', ...(asOf && { asOf }) }));
  return accounts.find((a) => a.code === code)?.balance ?? 0;
}
const sync = async (who = 'accountant', body = {}) => ok(await post(who, '/accounting/sync', body));
const binary = (req) => req.buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

before(async () => {
  api = await setup();
  const reg = await api.post(`${V1}/auth/register-society`).send({
    society: { name: 'Lotus Heights', city: 'Pune' },
    admin: { name: 'Anita Admin', email: 'admin@lotus.test', password: 'Password@123' },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  s.admin = reg.body.data;
  const block = ok(await post('admin', '/blocks', { name: 'A', floors: 2 }), 201);
  ok(await post('admin', '/units/bulk', { block: block._id, fromFloor: 1, toFloor: 2, unitsPerFloor: 2, areaSqft: 1000 }), 201);
  const units = ok(await get('admin', '/units', { limit: 50 }));
  s.units = units.map((u) => u._id);
  for (const [role, email, extra] of [
    ['accountant', 'acc@lotus.test'],
    ['facility_manager', 'fm@lotus.test'],
    ['admin', 'admin2@lotus.test'],
    ['resident', 'res@lotus.test', { unit: s.units[0], residentType: 'owner' }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    ok(await post('admin', '/users', { name: `${role} person`, email, password: 'Password@123', role, ...extra }), 201);
  }
  s.accountant = await login('acc@lotus.test');
  s.fm = await login('fm@lotus.test');
  s.admin2 = await login('admin2@lotus.test');
  s.resident = await login('res@lotus.test');
  ok(await patch('admin', '/society/me/settings', { billing: { fixedAmount: 100000, perSqftRate: 0, lateFeeType: 'flat', lateFeeValue: 5000 } }));

  const other = await api.post(`${V1}/auth/register-society`).send({
    society: { name: 'Other Society', city: 'Mumbai' },
    admin: { name: 'Otto Other', email: 'admin@other.test', password: 'Password@123' },
  });
  assert.equal(other.status, 201);
  s.other = other.body.data;
});
after(teardown);

describe('chart of accounts', () => {
  test('is created on first use with the standard codes', async () => {
    const accounts = ok(await get('accountant', '/accounting/accounts'));
    const codes = accounts.map((a) => a.code);
    const expected = ['1000', '1010', '1100', '1150', '2000', '2100', '2110', '2200', '2300', '3000', '3100', '3200', '3900',
      '4000', '4100', '4200', '4300', '4900', '5000', '5100', '5200', '5300', '5400', '5500', '5600', '5700', '5800', '5900'];
    assert.deepEqual(codes, expected);
    assert.ok(accounts.every((a) => a.system && a.active));
    assert.equal(accounts.find((a) => a.code === '1000').isBank, true);
    assert.equal(accounts.find((a) => a.code === '1010').isCash, true);
    assert.equal(accounts.find((a) => a.code === '2200').type, 'liability');
    assert.equal(accounts.find((a) => a.code === '3100').type, 'equity');
    // calling again does not duplicate
    assert.equal(ok(await get('admin', '/accounting/accounts')).length, 28);
  });

  test('sub-accounts can be added and deactivated; system accounts are locked', async () => {
    const bank2 = ok(await post('accountant', '/accounting/accounts', { code: '1001', name: 'HDFC savings', parent: '1000', isBank: true, bankDetails: { bankName: 'HDFC', accountNumber: '50100123456', ifsc: 'HDFC0001234' } }), 201);
    assert.equal(bank2.type, 'asset');
    assert.equal(bank2.system, false);
    assert.equal((await post('accountant', '/accounting/accounts', { code: '1001', name: 'Dup' })).status, 409);
    assert.equal((await post('accountant', '/accounting/accounts', { code: '5001', name: 'Bad parent', parent: '1000' })).status, 400);
    assert.equal((await post('accountant', '/accounting/accounts', { code: '4001', name: 'Fake bank', isBank: true })).status, 400);
    const sys = ok(await get('accountant', '/accounting/accounts')).find((a) => a.code === '4000');
    assert.equal((await patch('accountant', `/accounting/accounts/${sys._id}`, { active: false })).status, 409);
    assert.equal((await patch('accountant', `/accounting/accounts/${sys._id}`, { name: 'Renamed' })).status, 409);
    const misc = ok(await post('accountant', '/accounting/accounts', { code: '5910', name: 'Festival expenses', parent: '5900' }), 201);
    s.miscAccount = misc;
    const off = ok(await patch('accountant', `/accounting/accounts/${misc._id}`, { active: false }));
    assert.equal(off.active, false);
  });
});

describe('journal entries', () => {
  test('rejects unbalanced and malformed entries', async () => {
    const unbalanced = await post('accountant', '/accounting/journals', {
      date: today, narration: 'Unbalanced', lines: [{ code: '5300', debit: 1000 }, { code: '1010', credit: 900 }],
    });
    assert.equal(unbalanced.status, 400);
    assert.match(unbalanced.body.error.message, /does not balance/);
    const oneLine = await post('accountant', '/accounting/journals', { date: today, narration: 'One line', lines: [{ code: '5300', debit: 1000 }] });
    assert.equal(oneLine.status, 422);
    const both = await post('accountant', '/accounting/journals', { date: today, narration: 'Both sides', lines: [{ code: '5300', debit: 10, credit: 10 }, { code: '1010', credit: 0 }] });
    assert.equal(both.status, 422);
    const unknown = await post('accountant', '/accounting/journals', { date: today, narration: 'Unknown', lines: [{ code: '5999', debit: 10 }, { code: '1010', credit: 10 }] });
    assert.equal(unknown.status, 400);
    const inactive = await post('accountant', '/accounting/journals', { date: today, narration: 'Inactive', lines: [{ code: '5910', debit: 10 }, { code: '1010', credit: 10 }] });
    assert.equal(inactive.status, 400);
    assert.match(inactive.body.error.message, /inactive/);
  });

  test('posts a balanced manual entry and reverses it instead of deleting', async () => {
    const entry = ok(await post('accountant', '/accounting/journals', {
      date: today, narration: 'Plumbing repair paid in cash', reference: 'V-17', lines: [{ code: '5300', debit: 150000, memo: 'Tap washers' }, { code: '1010', credit: 150000 }],
    }), 201);
    assert.match(entry.number, /^JV-\d{6}$/);
    assert.equal(entry.total, 150000);
    assert.equal(entry.kind, 'manual');
    assert.equal(entry.lines[0].accountName, 'Repairs & maintenance');
    assert.equal(await balanceOf('accountant', '5300'), 150000);
    assert.equal(await balanceOf('accountant', '1010'), -150000);

    const rev = ok(await post('accountant', `/accounting/journals/${entry._id}/reverse`, { reason: 'Booked twice' }), 201);
    assert.equal(rev.kind, 'reversal');
    assert.equal(rev.lines.find((l) => l.code === '5300').credit, 150000);
    assert.equal(await balanceOf('accountant', '5300'), 0);
    const again = await post('accountant', `/accounting/journals/${entry._id}/reverse`, { reason: 'Again' });
    assert.equal(again.status, 409);
    const revOfRev = await post('accountant', `/accounting/journals/${rev._id}/reverse`, { reason: 'Undo' });
    assert.equal(revOfRev.status, 409);
    const original = ok(await get('accountant', `/accounting/journals/${entry._id}`));
    assert.equal(original.reversedBy.number, rev.number);
  });

  test('opening balances post once against 3900', async () => {
    const opening = ok(await post('accountant', '/accounting/opening-balances', {
      date: '2026-04-01',
      lines: [{ code: '1000', debit: 500000 }, { code: '3100', credit: 200000 }],
    }), 201);
    const eq = opening.lines.find((l) => l.code === '3900');
    assert.equal(eq.credit, 300000);
    assert.equal((await post('accountant', '/accounting/opening-balances', { date: '2026-04-01', lines: [{ code: '1000', debit: 1 }] })).status, 409);
    assert.equal((await post('admin', '/accounting/opening-balances', { date: '2026-04-01', lines: [{ code: '4000', credit: 1 }] })).status, 409);
    // correct it: reverse and post again
    ok(await post('accountant', `/accounting/journals/${opening._id}/reverse`, { reason: 'Wrong sinking fund figure' }), 201);
    const fixed = ok(await post('accountant', '/accounting/opening-balances', {
      date: '2026-04-01',
      lines: [{ code: '1000', debit: 500000 }, { code: '3100', credit: 250000 }, { code: '3200', credit: 50000 }],
    }), 201);
    assert.equal(fixed.lines.find((l) => l.code === '3900').credit, 200000);
    assert.equal(ok(await get('accountant', '/accounting/opening-balances'))._id, fixed._id);
    assert.equal(await balanceOf('accountant', '1000'), 500000);
    assert.equal((await post('accountant', '/accounting/opening-balances', { date: '2026-04-01', lines: [{ code: '4000', credit: 100 }, { code: '1000', debit: 100 }] })).status, 409);
  });
});

describe('automatic posting (sync)', () => {
  test('posts bills once (idempotent) to receivable and income', async () => {
    const gen = ok(await post('accountant', '/bills/generate', { period: '2026-10' }), 201);
    assert.equal(gen.created, 4);
    s.bills = ok(await get('accountant', '/bills', { period: '2026-10', limit: 50 }));
    const billed = s.bills.reduce((t, b) => t + b.total, 0);
    const r1 = await sync();
    assert.equal(r1.bills.posted, 4);
    assert.equal(r1.bills.errors, 0);
    const r2 = await sync();
    assert.equal(r2.bills.posted, 0);
    const full = await sync('accountant', { full: true });
    assert.equal(full.bills.posted, 0, 'a full re-sync posts nothing new');
    const entries = await get('accountant', '/accounting/journals', { sourceType: 'bill' });
    assert.equal(entries.body.meta.total, 4);
    assert.equal(await balanceOf('accountant', '1100'), billed);
    assert.equal(await balanceOf('accountant', '4000'), billed);
  });

  test('posts payments: cash to 1010, others to 1000; bounce reverses', async () => {
    const [b1, b2, b3] = s.bills;
    ok(await post('accountant', '/payments/offline', { bill: b1._id, amount: b1.total, method: 'cash' }), 201);
    ok(await post('accountant', '/payments/offline', { bill: b2._id, amount: 40000, method: 'upi', reference: 'UTR778899001' }), 201);
    s.chequePayment = ok(await post('accountant', '/payments/offline', { bill: b3._id, amount: 25000, method: 'cheque', reference: '004512' }), 201);
    const r = await sync();
    assert.equal(r.payments.posted, 3);
    assert.equal((await sync()).payments.posted, 0);
    assert.equal(await balanceOf('accountant', '1010'), -150000 + 150000 + b1.total); // cash: earlier manual entry reversed
    assert.equal(await balanceOf('accountant', '1000'), 500000 + 40000 + 25000);

    const bounce = await post('accountant', `/payments/${s.chequePayment._id}/bounce`, { reason: 'Insufficient funds', charge: false });
    assert.equal(bounce.status, 200, JSON.stringify(bounce.body));
    const after = await sync();
    assert.equal(after.payments.reversed, 1);
    assert.equal(await balanceOf('accountant', '1000'), 500000 + 40000);
    const reversals = await get('accountant', '/accounting/journals', { kind: 'reversal', search: 'Payment' });
    assert.ok(reversals.body.meta.total >= 1);
  });

  test('late fee changes post only the difference; cancelled bills are reversed', async () => {
    ok(await post('accountant', '/bills/generate', { period: '2026-09', dueDate: '2026-09-15' }), 201);
    const sept = ok(await get('accountant', '/bills', { period: '2026-09', limit: 50 }));
    assert.equal((await sync()).bills.posted, 4);
    const before4100 = await balanceOf('accountant', '4100');
    const fees = ok(await post('accountant', '/bills/apply-late-fees'));
    assert.ok(fees.updated >= 4);
    const r = await sync();
    assert.ok(r.bills.posted >= 4, JSON.stringify(r));
    const lateEntries = await get('accountant', '/accounting/journals', { sourceType: 'bill_late_fee' });
    assert.equal(lateEntries.body.meta.total, r.bills.posted);
    assert.equal(await balanceOf('accountant', '4100'), before4100 + 5000 * r.bills.posted);
    assert.equal((await sync()).bills.posted, 0);

    const victim = sept[3];
    const fresh = ok(await get('accountant', `/bills/${victim._id}`));
    const recv = await balanceOf('accountant', '1100');
    ok(await post('accountant', `/bills/${victim._id}/cancel`));
    const rc = await sync();
    assert.equal(rc.bills.reversed, 2, 'bill entry and its late-fee entry are reversed');
    assert.equal(await balanceOf('accountant', '1100'), recv - fresh.total);
    assert.equal((await sync()).bills.reversed, 0);
    s.cancelledTotal = fresh.total;
  });

  test('posts adjustments, amenity payments and payslips by their contracts', async (t) => {
    // These source models belong to other modules; the sync must work with whichever exist.
    const optional = (name, path) => mongoose.models[name] || import(path).then((m) => m.default).catch(() => null);
    const Adjustment = await optional('Adjustment', '../src/modules/billing/adjustment.model.js');
    const AmenityPayment = await optional('AmenityPayment', '../src/modules/amenities/amenityPayment.model.js');
    const Payslip = await optional('Payslip', '../src/modules/staffhr/payslip.model.js');
    if (!Adjustment || !AmenityPayment || !Payslip) t.diagnostic('some optional source models are missing; their checks are skipped');
    const society = new mongoose.Types.ObjectId(String(s.admin.user.society._id || s.admin.user.society));
    const unit = new mongoose.Types.ObjectId(s.units[1]);
    const before = { w: await balanceOf('accountant', '5800'), adv: await balanceOf('accountant', '2100'), dep: await balanceOf('accountant', '2110'), am: await balanceOf('accountant', '4200'), sal: await balanceOf('accountant', '5000') };
    if (Adjustment) {
      const waiver = await Adjustment.collection.insertOne({ society, unit, type: 'waiver', amount: 2000, status: 'pending', createdAt: new Date(), updatedAt: new Date() });
      await Adjustment.collection.insertOne({ society, unit, type: 'refund', amount: 1000, status: 'approved', method: 'bank', approvedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
      await Adjustment.collection.insertOne({ society, unit, type: 'credit', amount: 3000, status: 'approved', approvedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
      await Adjustment.collection.insertOne({ society, unit, type: 'bounce_charge', amount: 50000, status: 'approved', createdAt: new Date(), updatedAt: new Date() });
      await Adjustment.collection.insertOne({ society, unit, type: 'advance', payment: new mongoose.Types.ObjectId(), amount: 7000, status: 'approved', createdAt: new Date(), updatedAt: new Date() });
      let r = await sync();
      assert.equal(r.adjustments.posted, 2, 'refund + credit; pending waiver, bounce charge and payment advance are not posted');
      assert.equal(await balanceOf('accountant', '2100'), before.adv + 3000 - 1000);
      await Adjustment.collection.updateOne({ _id: waiver.insertedId }, { $set: { status: 'approved', approvedAt: new Date(), updatedAt: new Date() } });
      r = await sync();
      assert.equal(r.adjustments.posted, 1);
      assert.equal(await balanceOf('accountant', '5800'), before.w + 2000 + 3000);
      await Adjustment.collection.updateOne({ _id: waiver.insertedId }, { $set: { status: 'rejected', updatedAt: new Date() } });
      r = await sync();
      assert.equal(r.adjustments.reversed, 1);
      assert.equal(await balanceOf('accountant', '5800'), before.w + 3000);
    }
    if (AmenityPayment) {
      const user = new mongoose.Types.ObjectId(s.resident.user._id);
      const dep = await AmenityPayment.collection.insertOne({ society, unit, user, kind: 'deposit', amount: 500000, status: 'success', method: 'upi', paidAt: new Date(), refundedAmount: 0, createdAt: new Date(), updatedAt: new Date() });
      await AmenityPayment.collection.insertOne({ society, unit, user, kind: 'fee', amount: 200000, status: 'success', method: 'cash', paidAt: new Date(), refundedAmount: 0, createdAt: new Date(), updatedAt: new Date() });
      await AmenityPayment.collection.insertOne({ society, unit, user, kind: 'fee', amount: 0, status: 'success', method: 'online', createdAt: new Date(), updatedAt: new Date() });
      let r = await sync();
      assert.equal(r.amenityPayments.posted, 2);
      assert.equal(await balanceOf('accountant', '2110'), before.dep + 500000);
      assert.equal(await balanceOf('accountant', '4200'), before.am + 200000);
      await AmenityPayment.collection.updateOne({ _id: dep.insertedId }, { $set: { status: 'refunded', refundedAmount: 450000, refundedAt: new Date(), updatedAt: new Date() } });
      r = await sync();
      assert.equal(r.amenityPayments.posted, 1);
      assert.equal(await balanceOf('accountant', '2110'), before.dep + 50000);
      assert.equal((await sync()).amenityPayments.posted, 0);
    }
    if (Payslip) {
      const ps = await Payslip.collection.insertOne({
        society, employee: new mongoose.Types.ObjectId(), user: new mongoose.Types.ObjectId(), run: new mongoose.Types.ObjectId(),
        period: '2026-09', gross: 1800000, deductions: 200000, net: 1600000, status: 'approved', name: 'Ramesh', createdAt: new Date(), updatedAt: new Date(),
      });
      assert.equal((await sync()).payslips.posted, 0);
      await Payslip.collection.updateOne({ _id: ps.insertedId }, { $set: { status: 'paid', paidAt: new Date(), method: 'bank', updatedAt: new Date() } });
      assert.equal((await sync()).payslips.posted, 1);
      assert.equal(await balanceOf('accountant', '5000'), before.sal + 1600000);
    }
  });

  test('the scheduled job syncs every society', async () => {
    const { syncAllSocieties } = await import('../src/modules/accounting/sync.service.js');
    const r = await syncAllSocieties();
    assert.equal(r.errors, 0);
    assert.ok(r.societies >= 2);
    const { MODULE_JOBS } = await import('../src/jobs/registry.js');
    const job = MODULE_JOBS.find((j) => j.name === 'accounting-sync');
    assert.equal(job.everyMs, 15 * 60 * 1000);
  });
});

describe('vendors & purchase requests', () => {
  test('vendor CRUD, masking and roles', async () => {
    const v = ok(await post('accountant', '/expenses/vendors', {
      name: 'Shield Security Services', category: 'security', phone: '9811122233', email: 'ops@shield.test',
      gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234F', defaultAccount: '5100', tdsSection: '194C', tdsRate: 2,
      bank: { accountName: 'Shield Security', accountNumber: '123456789012', ifsc: 'ICIC0000123', bankName: 'ICICI' },
    }), 201);
    s.vendor = v;
    assert.equal(v.bank.accountNumber, '123456789012', 'finance sees the full number on the detail');
    assert.equal((await post('accountant', '/expenses/vendors', { name: 'shield security services' })).status, 409);
    assert.equal((await post('accountant', '/expenses/vendors', { name: 'Bad GST', gstin: 'XYZ' })).status, 422);
    assert.equal((await post('accountant', '/expenses/vendors', { name: 'Bad account', defaultAccount: '1000' })).status, 400);
    s.vendor2 = ok(await post('accountant', '/expenses/vendors', { name: 'Clean Co Housekeeping', category: 'housekeeping', defaultAccount: '5200' }), 201);

    const list = ok(await get('accountant', '/expenses/vendors', { search: 'shield' }));
    assert.equal(list.length, 1);
    assert.equal(list[0].bank.accountNumber, 'XXXX9012');
    const fmList = ok(await get('fm', '/expenses/vendors'));
    assert.equal(fmList.length, 2);
    const fmDetail = ok(await get('fm', `/expenses/vendors/${v._id}`));
    assert.equal(fmDetail.bank.accountNumber, 'XXXX9012');
    assert.equal((await post('fm', '/expenses/vendors', { name: 'FM vendor' })).status, 403);
    assert.equal((await get('resident', '/expenses/vendors')).status, 403);
    const upd = ok(await patch('accountant', `/expenses/vendors/${s.vendor2._id}`, { phone: '9822233344' }));
    assert.equal(upd.phone, '9822233344');
  });

  test('maker-checker approval with auto-approve threshold', async () => {
    const pr = ok(await post('fm', '/expenses/purchase-requests', {
      title: 'Replace corridor lights', vendor: s.vendor2._id, justification: 'Ten fused tubes on floor 2',
      items: [{ description: 'LED tube 20W', quantity: 10, rate: 45000 }],
    }), 201);
    assert.equal(pr.status, 'draft');
    assert.equal(pr.amount, 450000);
    assert.match(pr.number, /^PR-\d{6}$/);
    const edited = ok(await patch('fm', `/expenses/purchase-requests/${pr._id}`, { items: [{ description: 'LED tube 20W', quantity: 12, rate: 45000 }] }));
    assert.equal(edited.amount, 540000);
    const submitted = ok(await post('fm', `/expenses/purchase-requests/${pr._id}/submit`));
    assert.equal(submitted.status, 'pending');
    assert.equal((await patch('fm', `/expenses/purchase-requests/${pr._id}`, { title: 'Too late to edit' })).status, 409);
    assert.equal((await post('fm', `/expenses/purchase-requests/${pr._id}/approve`)).status, 403, 'facility manager cannot approve');
    assert.equal((await post('accountant', `/expenses/purchase-requests/${pr._id}/approve`)).status, 403, 'accountant cannot approve');
    const adminNotes = ok(await get('admin', '/notifications'));
    assert.ok(adminNotes.some((n) => n.type === 'purchase_request'));
    const approved = ok(await post('admin', `/expenses/purchase-requests/${pr._id}/approve`, { note: 'Go ahead' }));
    assert.equal(approved.status, 'approved');
    const fmNotes = ok(await get('fm', '/notifications'));
    assert.ok(fmNotes.some((n) => n.type === 'purchase_request' && /approved/.test(n.title)));
    s.approvedPr = approved;

    // an admin's own request needs a second admin
    const own = ok(await post('admin', '/expenses/purchase-requests', { title: 'Office printer', amount: 1500000, submit: true }), 201);
    assert.equal(own.status, 'pending');
    const self = await post('admin', `/expenses/purchase-requests/${own._id}/approve`);
    assert.equal(self.status, 403);
    assert.match(self.body.error.message, /own request/);
    assert.equal((await post('admin2', `/expenses/purchase-requests/${own._id}/reject`, {})).status, 422, 'rejection needs a note');
    const rejected = ok(await post('admin2', `/expenses/purchase-requests/${own._id}/reject`, { note: 'Not in budget' }));
    assert.equal(rejected.status, 'rejected');

    // FM sees only their own requests; finance sees all
    assert.equal(ok(await get('fm', '/expenses/purchase-requests')).length, 1);
    assert.equal(ok(await get('accountant', '/expenses/purchase-requests')).length, 2);
    assert.equal((await get('fm', `/expenses/purchase-requests/${own._id}`)).status, 404);

    // auto-approve small requests
    assert.equal((await patch('accountant', '/expenses/settings', { autoApproveLimit: 100000 })).status, 403);
    ok(await patch('admin', '/expenses/settings', { autoApproveLimit: 100000 }));
    const small = ok(await post('fm', '/expenses/purchase-requests', { title: 'Mop heads', amount: 80000, submit: true }), 201);
    assert.equal(small.status, 'approved');
    assert.equal(small.autoApproved, true);
    const big = ok(await post('fm', '/expenses/purchase-requests', { title: 'Pump motor', amount: 100001, submit: true }), 201);
    assert.equal(big.status, 'pending');
    const draft = ok(await post('fm', '/expenses/purchase-requests', { title: 'Draft to delete', amount: 5000 }), 201);
    assert.equal((await api.delete(`${V1}/expenses/purchase-requests/${draft._id}`).set(as('fm'))).status, 204);
  });
});

describe('vendor bills & payments', () => {
  test('vendor bill posts expense, GST and TDS', async () => {
    const before = { exp: await balanceOf('accountant', '5100'), ap: await balanceOf('accountant', '2000'), tds: await balanceOf('accountant', '2200') };
    const bill = ok(await post('accountant', '/expenses/bills', {
      vendor: s.vendor._id, billNo: 'SS/2026/101', billDate: today,
      lines: [{ description: 'Guards for October', account: '5100', amount: 1000000 }], gstAmount: 180000,
    }), 201);
    assert.equal(bill.subtotal, 1000000);
    assert.equal(bill.tdsRate, 2, 'vendor TDS rate is the default');
    assert.equal(bill.tdsAmount, 20000);
    assert.equal(bill.total, 1180000);
    assert.equal(bill.payable, 1160000);
    assert.equal(bill.status, 'unpaid');
    assert.match(bill.number, /^VB-\d{6}$/);
    s.vbill = bill;
    assert.equal(await balanceOf('accountant', '5100'), before.exp + 1180000, 'unclaimed GST is part of the cost');
    assert.equal(await balanceOf('accountant', '2000'), before.ap + 1160000);
    assert.equal(await balanceOf('accountant', '2200'), before.tds + 20000);
    const dup = await post('accountant', '/expenses/bills', { vendor: s.vendor._id, billNo: 'SS/2026/101', billDate: today, lines: [{ description: 'x', account: '5100', amount: 100 }] });
    assert.equal(dup.status, 409);
    const badAcc = await post('accountant', '/expenses/bills', { vendor: s.vendor._id, billNo: 'X1', billDate: today, lines: [{ description: 'x', account: '4000', amount: 100 }] });
    assert.equal(badAcc.status, 400);

    // GST claimed as input credit goes to 1150; bill linked to an approved purchase request
    const claimed = ok(await post('accountant', '/expenses/bills', {
      vendor: s.vendor2._id, billNo: 'CC-55', billDate: today, purchaseRequest: s.approvedPr._id, claimGst: true, tdsRate: 0,
      lines: [{ description: 'LED tubes', account: '5300', amount: 540000 }], gstAmount: 97200,
    }), 201);
    assert.equal(claimed.payable, 637200);
    assert.equal(await balanceOf('accountant', '1150'), 97200);
    const pr = ok(await get('fm', `/expenses/purchase-requests/${s.approvedPr._id}`));
    assert.equal(pr.status, 'converted');
    const twice = await post('accountant', '/expenses/bills', { vendor: s.vendor2._id, billNo: 'CC-56', billDate: today, purchaseRequest: s.approvedPr._id, lines: [{ description: 'x', account: '5300', amount: 100 }] });
    assert.equal(twice.status, 409);
    s.vbill2 = claimed;
    assert.equal((await get('fm', '/expenses/bills')).status, 403);
    // sync does not double-post our own documents
    const r = await sync();
    assert.equal(r.vendorBills.posted, 0);
  });

  test('payments settle bills, overpayment is refused, cancellation restores', async () => {
    const over = await post('accountant', '/expenses/payments', { vendor: s.vendor._id, date: today, amount: 1160001, method: 'bank', allocations: [{ bill: s.vbill._id, amount: 1160001 }] });
    assert.equal(over.status, 400);
    const mismatch = await post('accountant', '/expenses/payments', { vendor: s.vendor._id, date: today, amount: 1000, method: 'bank', allocations: [{ bill: s.vbill._id, amount: 900 }] });
    assert.equal(mismatch.status, 400);
    const wrongVendor = await post('accountant', '/expenses/payments', { vendor: s.vendor._id, date: today, amount: 1000, method: 'bank', allocations: [{ bill: s.vbill2._id, amount: 1000 }] });
    assert.equal(wrongVendor.status, 400);

    const ap = await balanceOf('accountant', '2000');
    const bank = await balanceOf('accountant', '1000');
    const p1 = ok(await post('accountant', '/expenses/payments', { vendor: s.vendor._id, date: today, amount: 600000, method: 'bank', reference: 'NEFT9988776655', allocations: [{ bill: s.vbill._id, amount: 600000 }] }), 201);
    assert.match(p1.number, /^VP-\d{6}$/);
    assert.equal(p1.account, '1000');
    let bill = ok(await get('accountant', `/expenses/bills/${s.vbill._id}`));
    assert.equal(bill.status, 'partial');
    assert.equal(bill.balance, 560000);
    const p2 = ok(await post('accountant', '/expenses/payments', { vendor: s.vendor._id, date: today, amount: 560000, method: 'cheque', reference: '000123', allocations: [{ bill: s.vbill._id, amount: 560000 }] }), 201);
    bill = ok(await get('accountant', `/expenses/bills/${s.vbill._id}`));
    assert.equal(bill.status, 'paid');
    assert.equal(bill.payments.length, 2);
    assert.equal(await balanceOf('accountant', '2000'), ap - 1160000);
    assert.equal(await balanceOf('accountant', '1000'), bank - 1160000);
    assert.equal((await post('accountant', '/expenses/payments', { vendor: s.vendor._id, date: today, amount: 1, method: 'bank', allocations: [{ bill: s.vbill._id, amount: 1 }] })).status, 409);
    assert.equal((await post('accountant', `/expenses/bills/${s.vbill._id}/cancel`, { reason: 'Wrong vendor' })).status, 409, 'paid bills cannot be cancelled');

    ok(await post('accountant', `/expenses/payments/${p2._id}/cancel`, { reason: 'Cheque not issued' }));
    bill = ok(await get('accountant', `/expenses/bills/${s.vbill._id}`));
    assert.equal(bill.status, 'partial');
    assert.equal(bill.paid, 600000);
    assert.equal(await balanceOf('accountant', '2000'), ap - 600000);
    assert.equal((await post('accountant', `/expenses/payments/${p2._id}/cancel`, { reason: 'again' })).status, 409);
    s.vendorPayment = p1;

    const stmt = ok(await get('accountant', `/expenses/vendors/${s.vendor._id}/statement`));
    assert.equal(stmt.closing, 560000);
    assert.equal(stmt.outstanding, 560000);
    assert.equal(stmt.rows.length, 2);
  });

  test('cancelling an unpaid bill reverses it and frees its purchase request', async () => {
    const before = await balanceOf('accountant', '5300');
    const res = ok(await post('accountant', `/expenses/bills/${s.vbill2._id}/cancel`, { reason: 'Duplicate invoice' }));
    assert.equal(res.status, 'cancelled');
    assert.equal(await balanceOf('accountant', '5300'), before - 540000);
    assert.equal(await balanceOf('accountant', '1150'), 0);
    const pr = ok(await get('admin', `/expenses/purchase-requests/${s.approvedPr._id}`));
    assert.equal(pr.status, 'approved');
  });

  test('recurring template creates one bill per month', async () => {
    const t = ok(await post('accountant', '/expenses/recurring', {
      name: 'Housekeeping contract', vendor: s.vendor2._id, dayOfMonth: 1, dueDays: 10, startDate: '2026-01-01',
      lines: [{ description: 'Monthly housekeeping', account: '5200', amount: 4500000 }],
    }), 201);
    const bill = ok(await post('accountant', `/expenses/recurring/${t._id}/run`), 201);
    assert.equal(bill.recurringPeriod, today.slice(0, 7));
    assert.equal(bill.billDate, `${today.slice(0, 7)}-01`);
    assert.equal((await post('accountant', `/expenses/recurring/${t._id}/run`)).status, 409);
    const { generateRecurringBills } = await import('../src/modules/expenses/payables.service.js');
    assert.equal((await generateRecurringBills()).created, 0, 'job skips templates already billed this month');
    const paused = ok(await patch('accountant', `/expenses/recurring/${t._id}`, { active: false }));
    assert.equal(paused.active, false);
    s.recurringBill = bill;
  });

  test('due-soon reminders go to accountants once', async () => {
    const soon = new Date(Date.now() + 2 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    ok(await post('accountant', '/expenses/bills', { vendor: s.vendor2._id, billNo: 'CC-DUE', billDate: today, dueDate: soon, tdsRate: 0, lines: [{ description: 'Garbage bags', account: '5200', amount: 120000 }] }), 201);
    const { vendorBillDueReminders } = await import('../src/modules/expenses/payables.service.js');
    const r = await vendorBillDueReminders();
    assert.ok(r.reminded >= 1);
    assert.equal((await vendorBillDueReminders()).reminded, 0);
    const notes = ok(await get('accountant', '/notifications'));
    assert.ok(notes.some((n) => n.type === 'vendor_bill'));
  });

  test('payables ageing and expense reports', async () => {
    const ageing = ok(await get('accountant', '/expenses/reports/ageing'));
    const shield = ageing.rows.find((r) => r.vendor === 'Shield Security Services');
    assert.equal(shield.d0_30, 560000);
    assert.equal(ageing.totals.total, ageing.rows.reduce((t, r) => t + r.total, 0));
    const exp = ok(await get('accountant', '/expenses/reports/expenses', { from: '2026-04-01', to: today }));
    const sec = exp.rows.find((r) => r.key === '5100');
    assert.equal(sec.total, 1180000);
    const cat = ok(await get('accountant', '/expenses/reports/expenses', { from: '2026-04-01', to: today, groupBy: 'category' }));
    assert.equal(cat.rows.find((r) => r.key === 'security').total, 1180000);
    const xlsx = await binary(get('accountant', '/expenses/reports/ageing', { format: 'xlsx' }));
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
  });
});

describe('reports', () => {
  test('trial balance balances and balance sheet ties out', async () => {
    const tb = ok(await get('accountant', '/accounting/reports/trial-balance', { from: '2026-04-01', to: today }));
    assert.equal(tb.balanced, true);
    assert.equal(tb.totals.closingDebit, tb.totals.closingCredit);
    assert.ok(tb.rows.length > 5);
    const bs = ok(await get('accountant', '/accounting/reports/balance-sheet', { asOf: today }));
    assert.equal(bs.balanced, true);
    assert.equal(bs.totalAssets, bs.totalLiabilities + bs.totalFunds);
  });

  test('income & expenditure shows billed income and expenses', async () => {
    const pl = ok(await get('accountant', '/accounting/reports/income-expenditure', { from: '2026-04-01', to: today }));
    const bills = ok(await get('accountant', '/bills', { limit: 100 })).filter((b) => b.status !== 'cancelled');
    const maintenance = bills.reduce((t, b) => t + b.amount, 0);
    const lateFees = bills.reduce((t, b) => t + b.lateFee, 0);
    assert.equal(pl.income.find((r) => r.code === '4000').amount, maintenance);
    assert.equal(pl.income.find((r) => r.code === '4100')?.amount || 0, lateFees);
    assert.equal(pl.expenses.find((r) => r.code === '5100').amount, 1180000);
    assert.equal(pl.surplus, pl.totalIncome - pl.totalExpenses);
    const outOfRange = ok(await get('accountant', '/accounting/reports/income-expenditure', { from: '2025-04-01', to: '2025-12-31' }));
    assert.equal(outOfRange.totalIncome, 0);
  });

  test('ledger, funds and cash/bank book', async () => {
    const ledger = ok(await get('accountant', '/accounting/reports/ledger', { code: '1000', from: '2026-04-01', to: today }));
    assert.equal(ledger.closing, await balanceOf('accountant', '1000'));
    assert.equal(ledger.rows.at(-1).balance, ledger.closing);
    assert.equal(ledger.opening + ledger.debit - ledger.credit, ledger.closing);
    const funds = ok(await get('accountant', '/accounting/reports/funds', { from: '2026-04-01', to: today }));
    assert.equal(funds.rows.find((r) => r.code === '3100').closing, 250000);
    const book = ok(await get('accountant', '/accounting/reports/cash-bank-book', { from: '2026-04-01', to: today }));
    assert.deepEqual(book.books.map((b) => b.account.code), ['1000', '1001', '1010']);
    assert.equal((await get('accountant', '/accounting/reports/cash-bank-book', { code: '4000' })).status, 400);
    assert.equal((await get('accountant', '/accounting/reports/ledger', { code: '9999' })).status, 404);
  });

  test('downloads Excel, PDF, Tally XML and the journal', async () => {
    for (const path of ['trial-balance', 'income-expenditure', 'balance-sheet', 'funds', 'cash-bank-book']) {
      // eslint-disable-next-line no-await-in-loop
      const x = await binary(get('accountant', `/accounting/reports/${path}`, { format: 'xlsx' }));
      assert.equal(x.status, 200, path);
      assert.match(x.headers['content-type'], /spreadsheetml/);
      assert.equal(x.body.subarray(0, 2).toString(), 'PK');
      // eslint-disable-next-line no-await-in-loop
      const p = await binary(get('accountant', `/accounting/reports/${path}`, { format: 'pdf' }));
      assert.equal(p.status, 200, path);
      assert.equal(p.body.subarray(0, 5).toString(), '%PDF-');
    }
    const ledgerPdf = await binary(get('accountant', '/accounting/reports/ledger', { code: '1100', format: 'pdf' }));
    assert.equal(ledgerPdf.status, 200);
    const tally = await binary(get('accountant', '/accounting/exports/tally', { from: '2026-04-01', to: today }));
    assert.equal(tally.status, 200);
    const xml = tally.body.toString();
    assert.match(xml, /<ENVELOPE>/);
    assert.match(xml, /VCHTYPE="Sales"/);
    assert.match(xml, /VCHTYPE="Receipt"/);
    assert.match(xml, /VCHTYPE="Payment"/);
    assert.match(xml, /<LEDGERNAME>Maintenance receivable<\/LEDGERNAME>/);
    const masters = await binary(get('accountant', '/accounting/exports/tally', { kind: 'masters' }));
    assert.match(masters.body.toString(), /<PARENT>Bank Accounts<\/PARENT>/);
    const journal = await binary(get('accountant', '/accounting/exports/journal', { from: '2026-04-01', to: today }));
    assert.equal(journal.status, 200);
    assert.equal(journal.body.subarray(0, 2).toString(), 'PK');
  });
});

describe('budget', () => {
  test('budget vs actual with variance', async () => {
    const fy = Number(today.slice(5, 7)) >= 4 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
    assert.equal((await put('accountant', `/accounting/budgets/${fy}`, { lines: [{ code: '1000', amount: 100 }] })).status, 400);
    const saved = ok(await put('accountant', `/accounting/budgets/${fy}`, { lines: [{ code: '5100', amount: 2000000 }, { code: '4000', amount: 5000000 }] }));
    assert.equal(saved.lines.length, 2);
    const report = ok(await get('accountant', `/accounting/budgets/${fy}/report`));
    const sec = report.expenses.find((r) => r.code === '5100');
    assert.equal(sec.budget, 2000000);
    assert.equal(sec.actual, 1180000);
    assert.equal(sec.variance, -820000);
    assert.equal(sec.variancePct, -41);
    ok(await put('accountant', `/accounting/budgets/${fy}`, { lines: [{ code: '4000', amount: 0 }] }));
    assert.equal(ok(await get('accountant', `/accounting/budgets/${fy}`)).lines.length, 1);
    const file = await binary(get('accountant', `/accounting/budgets/${fy}/report`, { format: 'xlsx' }));
    assert.equal(file.status, 200);
  });
});

describe('bank reconciliation', () => {
  test('imports a statement, auto-matches, de-duplicates and books bank charges', async () => {
    // book side on 1000 today: UPI receipt 40000 (UTR778899001), vendor payment 600000 (NEFT9988776655)
    const csv = [
      'Statement of account,,,,,',
      'Account,XXXX4321,,,,',
      'Txn Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      `${dmy(today)},UPI/UTR778899001/Flat A-102,UTR778899001,,400.00,"5,400.00"`,
      `${dmy(today)},NEFT to Shield Security,NEFT9988776655,"6,000.00",,"-600.00"`,
      `${dmy(today)},SMS charges,,59.00,,"-659.00"`,
      `${dmy(today)},Unknown deposit,,,"1,234.00","575.00"`,
      'Closing balance,,,,,575.00',
    ].join('\n');
    const preview = ok(await api.post(`${V1}/accounting/bank/1000/preview`).set(as('accountant')).attach('file', Buffer.from(csv), 'stmt.csv'));
    assert.equal(preview.totalLines, 4);
    assert.equal(preview.columns.date, 'Txn Date');
    assert.equal(preview.columns.debit, 'Withdrawal Amt.');

    const imp = ok(await api.post(`${V1}/accounting/bank/1000/import`).set(as('accountant')).attach('file', Buffer.from(csv), 'stmt.csv'), 201);
    assert.equal(imp.imported, 4);
    assert.equal(imp.autoMatched, 2);
    const again = ok(await api.post(`${V1}/accounting/bank/1000/import`).set(as('accountant')).attach('file', Buffer.from(csv), 'stmt.csv'), 201);
    assert.equal(again.imported, 0);
    assert.equal(again.duplicates, 4);

    const lines = ok(await get('accountant', '/accounting/bank/1000/lines', { limit: 50 }));
    assert.equal(lines.length, 4);
    const charge = lines.find((l) => l.description === 'SMS charges');
    assert.equal(charge.status, 'unmatched');
    assert.equal(charge.withdrawal, 5900);
    const wrongKind = await post('accountant', `/accounting/bank/lines/${charge._id}/create-entry`, { kind: 'interest' });
    assert.equal(wrongKind.status, 400);
    const booked = ok(await post('accountant', `/accounting/bank/lines/${charge._id}/create-entry`, { kind: 'bank_charge' }), 201);
    assert.equal(booked.line.status, 'matched');
    assert.equal(booked.entry.lines.find((l) => l.code === '5700').debit, 5900);

    // manual unmatch / re-match
    const upi = lines.find((l) => l.reference === 'UTR778899001');
    assert.equal(upi.status, 'matched');
    ok(await post('accountant', `/accounting/bank/lines/${upi._id}/unmatch`));
    const cands = ok(await get('accountant', `/accounting/bank/lines/${upi._id}/candidates`));
    const best = cands.find((c) => c.amount === 40000);
    assert.ok(best);
    const wrong = cands.find((c) => c.amount !== 40000);
    if (wrong) assert.equal((await post('accountant', `/accounting/bank/lines/${upi._id}/match`, { entryLines: [wrong.lineId] })).status, 400);
    const matched = ok(await post('accountant', `/accounting/bank/lines/${upi._id}/match`, { entryLines: [best.lineId] }));
    assert.equal(matched.matchType, 'manual');
    const otherLine = lines.find((l) => l.description === 'Unknown deposit');
    assert.equal((await post('accountant', `/accounting/bank/lines/${otherLine._id}/match`, { entryLines: [best.lineId] })).status, 409);
    ok(await post('accountant', `/accounting/bank/lines/${otherLine._id}/ignore`));

    const summary = ok(await get('accountant', '/accounting/bank/1000/summary'));
    assert.equal(summary.bookBalance, await balanceOf('accountant', '1000'));
    assert.equal(summary.statementBalance, 57500);
    assert.equal(summary.counts.matched, 3);
    assert.equal(summary.counts.ignored, 1);
    assert.equal(summary.counts.unmatchedStatement, 0);
    assert.equal(summary.expectedBankBalance, summary.bookBalance - summary.bookReceiptsPending + summary.bookPaymentsPending);

    // unmatching a booked charge reverses its entry
    const exp5700 = await balanceOf('accountant', '5700');
    ok(await post('accountant', `/accounting/bank/lines/${charge._id}/unmatch`));
    assert.equal(await balanceOf('accountant', '5700'), exp5700 - 5900);
    const rebook = ok(await post('accountant', `/accounting/bank/lines/${charge._id}/create-entry`, { kind: 'bank_charge' }), 201);
    assert.equal(rebook.line.status, 'matched');

    const accounts = ok(await get('accountant', '/accounting/bank/accounts'));
    assert.deepEqual(accounts.map((a) => a.code), ['1000', '1001']);
    assert.equal((await get('accountant', '/accounting/bank/1010/summary')).status, 400, 'cash is not a bank account');
  });

  test('reads XLSX statements with a single signed amount column', async () => {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Date', 'Description', 'Amount', 'Ref']);
    ws.addRow([new Date(`${today}T00:00:00Z`), 'Interest credit', 125.5, 'INT01']);
    ws.addRow([new Date(`${today}T00:00:00Z`), 'Cheque return', -250, 'CHQ9']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const imp = ok(await api.post(`${V1}/accounting/bank/1001/import`).set(as('accountant')).attach('file', buf, 'hdfc.xlsx'), 201);
    assert.equal(imp.imported, 2);
    const lines = ok(await get('accountant', '/accounting/bank/1001/lines'));
    assert.equal(lines.find((l) => l.reference === 'INT01').deposit, 12550);
    assert.equal(lines.find((l) => l.reference === 'CHQ9').withdrawal, 25000);
    const interest = lines.find((l) => l.reference === 'INT01');
    ok(await post('accountant', `/accounting/bank/lines/${interest._id}/create-entry`, { kind: 'interest' }), 201);
    assert.equal(await balanceOf('accountant', '4300'), 12550);
    // explicit mapping overrides detection
    const bad = await api.post(`${V1}/accounting/bank/1001/preview`).set(as('accountant')).field('mapping', JSON.stringify({ date: 'Nope' })).attach('file', buf, 'hdfc.xlsx');
    assert.equal(bad.status, 400);
  });
});

describe('permissions & tenant isolation', () => {
  test('residents and facility managers have no accounting access', async () => {
    for (const path of ['/accounting/accounts', '/accounting/journals', '/accounting/reports/trial-balance', '/accounting/bank/accounts', '/expenses/bills', '/expenses/payments']) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await get('resident', path)).status, 403, path);
    }
    assert.equal((await get('fm', '/accounting/accounts')).status, 403);
    assert.equal((await post('fm', '/accounting/sync')).status, 403);
    assert.equal((await post('resident', '/expenses/purchase-requests', { title: 'Resident request', amount: 100 })).status, 403);
    assert.equal((await api.get(`${V1}/accounting/accounts`)).status, 401);
  });

  test('another society sees none of this data', async () => {
    const o = bearer(s.other.accessToken);
    const journals = await api.get(`${V1}/accounting/journals`).set(o);
    assert.equal(journals.status, 200);
    assert.equal(journals.body.meta.total, 0);
    const accounts = ok(await api.get(`${V1}/accounting/accounts`).query({ withBalances: 'true' }).set(o));
    assert.equal(accounts.length, 28, 'own fresh chart');
    assert.ok(accounts.every((a) => a.balance === 0));
    assert.equal((await api.get(`${V1}/accounting/journals/${s.vbill._id}`).set(o)).status, 404);
    assert.equal((await api.get(`${V1}/expenses/vendors/${s.vendor._id}`).set(o)).status, 404);
    assert.equal((await api.get(`${V1}/expenses/bills/${s.vbill._id}`).set(o)).status, 404);
    assert.equal((await api.post(`${V1}/expenses/payments`).set(o).send({ vendor: s.vendor._id, date: today, amount: 100, method: 'bank', allocations: [{ bill: s.vbill._id, amount: 100 }] })).status, 404);
    assert.equal(ok(await api.get(`${V1}/expenses/vendors`).set(o)).length, 0);
    const tb = ok(await api.get(`${V1}/accounting/reports/trial-balance`).set(o));
    assert.equal(tb.rows.length, 0);
    const lines = ok(await get('accountant', '/accounting/bank/1000/lines'));
    assert.equal((await api.post(`${V1}/accounting/bank/lines/${lines[0]._id}/unmatch`).set(o)).status, 404);
    assert.equal(ok(await api.get(`${V1}/expenses/purchase-requests`).set(o)).length, 0);
    const otherSync = ok(await api.post(`${V1}/accounting/sync`).set(o).send({}));
    assert.equal(otherSync.bills.posted, 0);
  });
});
