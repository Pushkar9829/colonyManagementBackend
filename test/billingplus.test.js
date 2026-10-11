import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { bearer, setup, teardown } from './helpers.js';

const { email } = await import('../src/integrations/email.js');
const { default: Mandate } = await import('../src/modules/payments/mandate.model.js');
const { default: Adjustment } = await import('../src/modules/billing/adjustment.model.js');
const billing = await import('../src/modules/billing/billing.service.js');

let api;
const s = { units: {} };
const sent = [];
const PASSWORD = 'Password@123';

const login = async (identifier) => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password: PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const as = (who) => bearer(s[who].accessToken);
const u = (label) => s.units[label];
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Emails go out in the background; poll briefly for them.
async function waitFor(find, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 50) {
    const hit = find();
    if (hit) return hit;
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  return find();
}

async function billFor(label, period) {
  const res = await api.get(`/api/v1/bills?unit=${u(label)}&period=${period}`).set(as('accountant'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data[0];
}
const detail = async (id) => (await api.get(`/api/v1/bills/${id}`).set(as('accountant'))).body.data;
const statementOf = async (label) => (await api.get(`/api/v1/bills/statement?unit=${u(label)}`).set(as('accountant'))).body.data;
const generate = (period, labels, extra = {}) => api.post('/api/v1/bills/generate').set(as('accountant')).send({ period, units: labels.map(u), ...extra });

before(async () => {
  api = await setup();
  // Capture outgoing email (console provider) to check attachments.
  const original = email.send.bind(email);
  email.send = async (msg) => {
    sent.push(msg);
    return original(msg);
  };

  const reg = await api.post('/api/v1/auth/register-society').send({
    society: { name: 'Palm Grove', city: 'Nagpur' },
    admin: { name: 'Admin Palm', email: 'admin@pg.test', password: PASSWORD },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  s.admin = reg.body.data;
  const h = as('admin');
  const block = await api.post('/api/v1/blocks').set(h).send({ name: 'A' });
  s.block = block.body.data._id;
  await api.post('/api/v1/units/bulk').set(h).send({ block: s.block, fromFloor: 1, toFloor: 3, unitsPerFloor: 2, areaSqft: 1000 });
  const units = await api.get('/api/v1/units?limit=50').set(h);
  for (const unit of units.body.data) s.units[unit.label] = unit._id;

  const people = [
    ['accountant', { name: 'Anil Accounts', email: 'acc@pg.test', role: 'accountant' }],
    ['fm', { name: 'Farah Facility', email: 'fm@pg.test', role: 'facility_manager' }],
    ['r1', { name: 'Ravi One', email: 'r1@pg.test', role: 'resident', unit: u('A-101'), residentType: 'owner' }],
    ['r2', { name: 'Rita Two', email: 'r2@pg.test', role: 'resident', unit: u('A-102'), residentType: 'tenant' }],
  ];
  for (const [key, body] of people) {
    // eslint-disable-next-line no-await-in-loop
    const res = await api.post('/api/v1/users').set(h).send({ ...body, password: PASSWORD });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // eslint-disable-next-line no-await-in-loop
    s[key] = await login(body.email);
  }

  // A second society for isolation checks.
  const other = await api.post('/api/v1/auth/register-society').send({
    society: { name: 'Other Hills' },
    admin: { name: 'Other Admin', email: 'admin@oh.test', password: PASSWORD },
  });
  s.other = other.body.data;
  const ob = await api.post('/api/v1/blocks').set(as('other')).send({ name: 'Z' });
  await api.post('/api/v1/units/bulk').set(as('other')).send({ block: ob.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 1 });
  s.otherUnit = (await api.get('/api/v1/units').set(as('other'))).body.data[0]._id;
});
after(teardown);

describe('finance settings', () => {
  test('defaults, permissions and validation', async () => {
    const def = await api.get('/api/v1/finance/settings').set(as('accountant'));
    assert.equal(def.status, 200);
    assert.equal(def.body.data.gstEnabled, false);
    assert.deepEqual(def.body.data.headAccounts.map((h) => h.account), ['3100', '3200']);

    assert.equal((await api.get('/api/v1/finance/settings').set(as('r1'))).status, 403);
    assert.equal((await api.patch('/api/v1/finance/settings').set(as('fm')).send({ gstEnabled: true })).status, 403);
    const bad = await api.patch('/api/v1/finance/settings').set(as('accountant')).send({ gstin: 'NOT-A-GSTIN' });
    assert.equal(bad.status, 422);

    const res = await api.patch('/api/v1/finance/settings').set(as('accountant')).send({
      gstin: '27aapfu0939f1zv',
      gstEnabled: true,
      gstDefaultRate: 18,
      headGst: [{ head: 'Sinking fund', rate: 0 }, { head: 'Repair fund', rate: 0 }],
      nonOccupancy: { percent: 10, appliesTo: ['rented'] },
      chequeBounceCharge: 50000,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.gstin, '27AAPFU0939F1ZV');
    assert.equal(res.body.data.nonOccupancy.percent, 10);
    assert.equal(res.body.data.waiverApprovalRequired, true, 'untouched fields keep defaults');
  });
});

describe('bill generation: GST, funds, non-occupancy', () => {
  test('lines carry accounts, GST rates and CGST/SGST', async () => {
    await api.patch('/api/v1/society/me/settings').set(as('admin')).send({
      billing: { fixedAmount: 50000, perSqftRate: 300, chargeHeads: [{ name: 'Sinking fund', amount: 20000 }, { name: 'Repair fund', amount: 10000 }], lateFeeType: 'flat', lateFeeValue: 10000 },
    });
    await api.patch(`/api/v1/units/${u('A-102')}`).set(as('admin')).send({ occupancy: 'rented' });

    const gen = await generate('2026-07', ['A-101', 'A-102'], { dueDate: '2026-07-15' });
    assert.equal(gen.status, 201, JSON.stringify(gen.body));
    assert.equal(gen.body.data.created, 2);

    const b1 = await billFor('A-101', '2026-07');
    const line = (b, head) => b.lines.find((l) => l.head === head);
    assert.equal(line(b1, 'Maintenance').account, '4000');
    assert.equal(line(b1, 'Maintenance').gstRate, 18);
    assert.equal(line(b1, 'Maintenance (1000 sq.ft)').amount, 300000);
    assert.equal(line(b1, 'Sinking fund').account, '3100');
    assert.equal(line(b1, 'Sinking fund').gstRate, 0);
    assert.equal(line(b1, 'Repair fund').account, '3200');
    assert.deepEqual([line(b1, 'CGST 9%').amount, line(b1, 'SGST 9%').amount], [31500, 31500]);
    assert.equal(line(b1, 'CGST 9%').account, '2300');
    assert.equal(b1.amount, 443000);
    assert.equal(b1.amount, b1.lines.reduce((x, l) => x + l.amount, 0), 'amount is the sum of lines');
    assert.equal(b1.gstin, '27AAPFU0939F1ZV');
    assert.equal(b1.lines.some((l) => l.kind === 'non_occupancy'), false, 'owner-occupied: no non-occupancy charge');

    const b2 = await billFor('A-102', '2026-07');
    const noc = b2.lines.find((l) => l.kind === 'non_occupancy');
    assert.equal(noc.amount, 35000); // 10% of ₹3,500 maintenance
    assert.equal(noc.account, '4000');
    assert.equal(line(b2, 'CGST 9%').amount, 34650);
    assert.equal(b2.amount, 484300);
    s.julyA101 = b1._id;
    s.julyA102 = b2._id;

    const d = await detail(b1._id);
    assert.deepEqual(d.tax, { taxable: 350000, exempt: 30000, cgst: 31500, sgst: 31500, gst: 63000 });
  });

  test('bill PDF is a tax invoice download', async () => {
    const res = await api.get(`/api/v1/bills/${s.julyA101}/pdf`).set(as('r1')).buffer(true).parse(binary);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/pdf/);
    assert.equal(res.body.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await api.get(`/api/v1/bills/${s.julyA101}/pdf`).set(as('r2'))).status, 404, 'other residents cannot download it');
  });

  test('"email me this bill" attaches the PDF', async () => {
    sent.length = 0;
    const res = await api.post(`/api/v1/bills/${s.julyA101}/email`).set(as('r1'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const mail = await waitFor(() => sent.find((m) => m.to === 'r1@pg.test'));
    assert.ok(mail, 'email sent to the signed-in resident');
    assert.equal(mail.attachments[0].type, 'application/pdf');
    assert.equal(mail.attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  });
});

describe('late-fee waiver (maker-checker)', () => {
  test('accountant requests, admin approves, total drops and household is told', async () => {
    const fees = await api.post('/api/v1/bills/apply-late-fees').set(as('accountant'));
    assert.equal(fees.body.data.updated, 2);
    assert.equal((await detail(s.julyA101)).total, 453000);

    assert.equal((await api.post('/api/v1/bills/waivers').set(as('r1')).send({ bill: s.julyA101, amount: 10000, reason: 'Paid on time' })).status, 403);
    const tooMuch = await api.post('/api/v1/bills/waivers').set(as('accountant')).send({ bill: s.julyA101, amount: 999999, reason: 'Too much' });
    assert.equal(tooMuch.status, 400);

    const req = await api.post('/api/v1/bills/waivers').set(as('accountant')).send({ bill: s.julyA101, amount: 10000, reason: 'Bank delay, late fee waived' });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal(req.body.data.status, 'pending');
    assert.equal((await detail(s.julyA101)).total, 453000, 'pending waiver changes nothing');
    const dup = await api.post('/api/v1/bills/waivers').set(as('accountant')).send({ bill: s.julyA101, amount: 5000, reason: 'Second one' });
    assert.equal(dup.status, 409);

    assert.equal((await api.post(`/api/v1/bills/waivers/${req.body.data._id}/approve`).set(as('accountant')).send({})).status, 403, 'maker cannot check');
    const queue = await api.get('/api/v1/bills/waivers?status=pending').set(as('admin'));
    assert.equal(queue.body.data.length, 1);

    const ok = await api.post(`/api/v1/bills/waivers/${req.body.data._id}/approve`).set(as('admin')).send({ note: 'OK' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, 'approved');
    assert.equal(ok.body.data.approvedBy.name, 'Admin Palm');
    const bill = await detail(s.julyA101);
    assert.equal(bill.waived, 10000);
    assert.equal(bill.total, 443000);
    assert.equal(bill.status, 'unpaid');

    const again = await api.post(`/api/v1/bills/waivers/${req.body.data._id}/approve`).set(as('admin')).send({});
    assert.equal(again.status, 409);

    const notes = await api.get('/api/v1/notifications').set(as('r1'));
    assert.ok(notes.body.data.some((n) => /waived/.test(n.title)), 'household notified');
  });

  test('an admin cannot approve their own waiver; rejection leaves the bill alone', async () => {
    const own = await api.post('/api/v1/bills/waivers').set(as('admin')).send({ bill: s.julyA102, amount: 10000, reason: 'Admin request' });
    assert.equal(own.status, 201);
    assert.equal((await api.post(`/api/v1/bills/waivers/${own.body.data._id}/approve`).set(as('admin')).send({})).status, 403);
    const rej = await api.post(`/api/v1/bills/waivers/${own.body.data._id}/reject`).set(as('admin')).send({ note: 'No' });
    assert.equal(rej.status, 403, 'the maker may not decide either way');
    const adj = await Adjustment.findById(own.body.data._id);
    adj.requestedBy = s.accountant.user._id;
    await adj.save();
    const rejected = await api.post(`/api/v1/bills/waivers/${own.body.data._id}/reject`).set(as('admin')).send({ note: 'No' });
    assert.equal(rejected.body.data.status, 'rejected');
    assert.equal((await detail(s.julyA102)).total, 494300);
  });
});

describe('defaulters and isDefaulter', () => {
  test('overdue unit is a defaulter until paid', async () => {
    const sid = s.admin.user.society._id;
    assert.equal(await billing.isDefaulter(sid, u('A-102')), true);
    assert.equal(await billing.isDefaulter(sid, u('A-201')), false);
    assert.equal(await billing.amenityBookingBlocked(sid, u('A-102')), false, 'restriction is off by default');
    await api.patch('/api/v1/finance/settings').set(as('accountant')).send({ restrictAmenityForDefaulters: true });
    assert.equal(await billing.amenityBookingBlocked(sid, u('A-102')), true);

    const pay = await api.post('/api/v1/payments/offline').set(as('accountant')).send({ bill: s.julyA102, amount: 494300, method: 'cash' });
    assert.equal(pay.status, 201);
    assert.equal(await billing.isDefaulter(sid, u('A-102')), false);
    const def = await api.get('/api/v1/bills/defaulters').set(as('accountant'));
    assert.deepEqual(def.body.data.map((d) => d.unit.label), ['A-101']);
    assert.equal(def.body.data[0].advance, 0);
  });
});

describe('cheque bounce', () => {
  test('reverses the payment and queues a bounce charge', async () => {
    sent.length = 0;
    const pay = await api.post('/api/v1/payments/offline').set(as('accountant')).send({ bill: s.julyA101, amount: 443000, method: 'cheque', reference: '004512' });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.equal((await detail(s.julyA101)).status, 'paid');
    s.chequePayment = pay.body.data._id;

    const receiptMail = await waitFor(() => sent.find((m) => m.to === 'r1@pg.test' && /receipt/i.test(m.subject)));
    assert.ok(receiptMail, 'receipt emailed automatically');
    assert.match(receiptMail.attachments[0].filename, /^RCPT-\d+\.pdf$/);

    const cash = (await api.get(`/api/v1/payments?unit=${u('A-102')}`).set(as('accountant'))).body.data[0];
    assert.equal((await api.post(`/api/v1/payments/${cash._id}/bounce`).set(as('accountant')).send({ reason: 'Not a cheque' })).status, 400);
    assert.equal((await api.post(`/api/v1/payments/${s.chequePayment}/bounce`).set(as('r1')).send({ reason: 'Insufficient funds' })).status, 403);

    const b = await api.post(`/api/v1/payments/${s.chequePayment}/bounce`).set(as('accountant')).send({ reason: 'Insufficient funds' });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.data.payment.status, 'bounced');
    assert.equal(b.body.data.payment.bounceReason, 'Insufficient funds');
    assert.equal(b.body.data.bounceCharge, 50000);
    const bill = await detail(s.julyA101);
    assert.equal(bill.paid, 0);
    assert.equal(bill.status, 'unpaid');
    assert.equal(bill.payments.length, 0);
    assert.equal(bill.bouncedPayments.length, 1);

    assert.equal((await api.post(`/api/v1/payments/${s.chequePayment}/bounce`).set(as('accountant')).send({ reason: 'Again' })).status, 409);
    const notes = await api.get('/api/v1/notifications').set(as('r1'));
    assert.ok(notes.body.data.some((n) => /bounced/.test(n.title)));

    const rcpt = await api.get(`/api/v1/payments/${s.chequePayment}/receipt.pdf`).set(as('r1')).buffer(true).parse(binary);
    assert.equal(rcpt.status, 200);
    assert.match(rcpt.headers['content-type'], /application\/pdf/);
  });
});

describe('advance credit, overpayment and refunds', () => {
  test('advance payment and overpayment become credit', async () => {
    // Simpler rates from here on.
    await api.patch('/api/v1/finance/settings').set(as('accountant')).send({ gstEnabled: false, nonOccupancy: { percent: 0 } });
    await api.patch('/api/v1/society/me/settings').set(as('admin')).send({ billing: { fixedAmount: 100000, perSqftRate: 0, chargeHeads: [] } });

    const adv = await api.post('/api/v1/payments/advance').set(as('accountant')).send({ unit: u('A-201'), amount: 150000, method: 'bank', reference: 'UTR123' });
    assert.equal(adv.status, 201, JSON.stringify(adv.body));
    assert.equal(adv.body.data.purpose, 'advance');
    assert.equal(adv.body.data.advanceAmount, 150000);
    assert.match(adv.body.data.receiptNumber, /^RCPT-/);
    assert.equal((await statementOf('A-201')).creditBalance, 150000);
    const receipt = await api.get(`/api/v1/payments/${adv.body.data._id}/receipt`).set(as('accountant'));
    assert.equal(receipt.body.data.bill, null);
    assert.equal(receipt.body.data.creditBalance, 150000);

    assert.equal((await api.post('/api/v1/payments/advance').set(as('r1')).send({ unit: u('A-101'), amount: 100, method: 'cash' })).status, 403);
  });

  test('next bills use the credit automatically and carry the bounce charge', async () => {
    const gen = await generate('2026-08', ['A-101', 'A-201', 'A-202'], { dueDate: '2026-12-31' });
    assert.equal(gen.status, 201, JSON.stringify(gen.body));
    assert.equal(gen.body.data.created, 3);
    assert.equal(gen.body.data.creditApplied, 100000);

    const a201 = await detail((await billFor('A-201', '2026-08'))._id);
    assert.equal(a201.status, 'paid');
    assert.equal(a201.creditApplied, 100000);
    assert.equal(a201.paid, 100000);
    assert.equal(a201.creditBalance, 50000, 'rest of the advance stays');
    assert.equal(a201.adjustments.filter((x) => x.type === 'credit_applied').length, 1);

    const a101 = await billFor('A-101', '2026-08');
    const charge = a101.lines.find((l) => l.kind === 'bounce_charge');
    assert.equal(charge.amount, 50000);
    assert.equal(charge.head, 'Cheque bounce charge');
    assert.equal(charge.account, '4900', 'bounce charges are other income');
    assert.equal(a101.amount, 150000);
    const adj = await Adjustment.findOne({ type: 'bounce_charge' });
    assert.equal(String(adj.bill), a101._id, 'bounce charge marked as billed');
    s.augA101 = a101._id;

    const next = await generate('2026-08', ['A-101']);
    assert.equal(next.body.data.created, 0);
  });

  test('offline overpayment is refused unless held as advance; refunds use the credit', async () => {
    const bill = await billFor('A-202', '2026-08');
    const refused = await api.post('/api/v1/payments/offline').set(as('accountant')).send({ bill: bill._id, amount: 105000, method: 'upi' });
    assert.equal(refused.status, 400);
    const ok = await api.post('/api/v1/payments/offline').set(as('accountant')).send({ bill: bill._id, amount: 105000, method: 'upi', excessAsAdvance: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.appliedAmount, 100000);
    assert.equal(ok.body.data.advanceAmount, 5000);
    assert.equal((await detail(bill._id)).status, 'paid');
    assert.equal((await statementOf('A-202')).creditBalance, 5000);

    const tooMuch = await api.post('/api/v1/bills/refunds').set(as('accountant')).send({ unit: u('A-202'), amount: 6000, method: 'upi' });
    assert.equal(tooMuch.status, 400);
    const refund = await api.post('/api/v1/bills/refunds').set(as('accountant')).send({ unit: u('A-202'), amount: 5000, method: 'upi', reference: 'RF-1' });
    assert.equal(refund.status, 201, JSON.stringify(refund.body));
    assert.equal(refund.body.data.type, 'refund');
    assert.equal(refund.body.data.status, 'approved');
    const st = await statementOf('A-202');
    assert.equal(st.creditBalance, 0);
    assert.equal(st.closingBalance, 0);
  });

  test('a bounced cheque that created an advance withdraws it', async () => {
    const bill = await billFor('A-201', '2026-08');
    assert.equal(bill.status, 'paid');
    const adv = await api.post('/api/v1/payments/advance').set(as('accountant')).send({ unit: u('A-201'), amount: 20000, method: 'cheque', reference: '771' });
    assert.equal((await statementOf('A-201')).creditBalance, 70000);
    const b = await api.post(`/api/v1/payments/${adv.body.data._id}/bounce`).set(as('accountant')).send({ reason: 'Signature mismatch', charge: false });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.data.bounceCharge, 0);
    const st = await statementOf('A-201');
    assert.equal(st.creditBalance, 50000);
    assert.equal(st.closingBalance, st.outstanding - st.creditBalance);
  });
});

describe('opening balances', () => {
  test('CSV import creates opening dues bills and advances, once per unit', async () => {
    const csv = 'Unit,Amount,As of\nA-301,1500.50,2026-03-31\nA-302,-200,31/03/2026\nZ-999,10,2026-03-31\n';
    const dry = await api.post('/api/v1/bills/opening-balances/import').set(as('accountant')).field('dryRun', 'true').attach('file', Buffer.from(csv), 'opening.csv');
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.data.dryRun, true);
    assert.equal(dry.body.data.valid, 2);
    assert.equal(await Adjustment.countDocuments({ type: 'opening_balance' }), 0);

    const res = await api.post('/api/v1/bills/opening-balances/import').set(as('accountant')).attach('file', Buffer.from(csv), 'opening.csv');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.imported, 2);
    assert.equal(res.body.data.failed, 1);
    assert.equal(res.body.data.results.find((r) => r.unit === 'Z-999').error, 'Unknown unit');

    const ob = await billFor('A-301', 'OPENING');
    assert.equal(ob.kind, 'opening');
    assert.equal(ob.total, 150050);
    assert.match(ob.billNumber, /^OB-/);
    assert.equal((await statementOf('A-302')).creditBalance, 20000);
    const st = await statementOf('A-301');
    assert.equal(st.entries[0].type, 'opening');
    assert.equal(st.closingBalance, 150050);

    const again = await api.post('/api/v1/bills/opening-balances').set(as('accountant')).send({ rows: [{ unit: 'A-301', amount: 100, asOf: '2026-03-31' }] });
    assert.equal(again.body.data.imported, 0);
    assert.equal(again.body.data.results[0].skipped, true);

    const tpl = await api.get('/api/v1/bills/opening-balances/template.xlsx').set(as('accountant')).buffer(true).parse(binary);
    assert.match(tpl.headers['content-type'], /spreadsheetml/);
    assert.equal((await api.post('/api/v1/bills/opening-balances').set(as('r1')).send({ rows: [{ unit: 'A-101', amount: 1, asOf: '2026-03-31' }] })).status, 403);
  });
});

describe('resident statement', () => {
  test('running balance with opening and closing', async () => {
    const st = await statementOf('A-101');
    // July bill 4,430 + late fee 100 − waiver 100 − cheque 4,430 + bounce 4,430 + Aug bill 1,500
    assert.deepEqual(st.entries.map((e) => e.type), ['bill', 'late_fee', 'waiver', 'payment', 'bounce', 'bill']);
    assert.equal(st.closingBalance, 593000);
    assert.equal(st.outstanding, 593000);
    assert.equal(st.closingBalance, st.outstanding - st.creditBalance);
    let running = st.openingBalance;
    for (const e of st.entries) {
      running += e.debit - e.credit;
      assert.equal(e.balance, running);
    }

    const mine = await api.get(`/api/v1/bills/statement?unit=${u('A-201')}`).set(as('r1'));
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.unit.label, 'A-101', 'residents always get their own unit');

    const from = st.entries[2].date;
    const later = (await api.get(`/api/v1/bills/statement?unit=${u('A-101')}&from=${from}`).set(as('accountant'))).body.data;
    assert.equal(later.openingBalance, st.entries[1].balance);
    assert.equal(later.closingBalance, st.closingBalance);

    const pdf = await api.get('/api/v1/bills/statement.pdf').set(as('r1')).buffer(true).parse(binary);
    assert.match(pdf.headers['content-type'], /application\/pdf/);
    assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
    const xlsx = await api.get(`/api/v1/bills/statement.xlsx?unit=${u('A-101')}`).set(as('accountant')).buffer(true).parse(binary);
    assert.match(xlsx.headers['content-type'], /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    assert.match(String(wb.worksheets[0].getCell('A1').value), /A-101/);

    assert.equal((await api.get('/api/v1/bills/statement').set(as('fm'))).status, 403);
  });
});

describe('utility metering', () => {
  test('tariffs and meters', async () => {
    const t = await api.post('/api/v1/meters/tariffs').set(as('accountant')).send({ type: 'water', name: 'Water 2026', slabs: [{ upTo: 10, rate: 2000 }, { upTo: null, rate: 3000 }], fixedCharge: 5000 });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const badSlabs = await api.post('/api/v1/meters/tariffs').set(as('accountant')).send({ type: 'gas', name: 'Gas', slabs: [{ upTo: 10, rate: 100 }] });
    assert.equal(badSlabs.status, 422);
    assert.equal((await api.post('/api/v1/meters/tariffs').set(as('fm')).send({ type: 'gas', name: 'Gas', slabs: [{ rate: 100 }] })).status, 403);

    const m = await api.post('/api/v1/meters').set(as('fm')).send({ unit: u('A-101'), type: 'water', serial: 'wm-101', initialReading: 100, installedAt: '2026-08-01T00:00:00+05:30' });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    assert.equal(m.body.data.serial, 'WM-101');
    s.meter = m.body.data._id;
    assert.equal((await api.post('/api/v1/meters').set(as('fm')).send({ unit: u('A-102'), type: 'water', serial: 'WM-101' })).status, 409);
    assert.equal((await api.post('/api/v1/meters').set(as('r1')).send({ unit: u('A-101'), type: 'gas', serial: 'G-1' })).status, 403);
  });

  test('manual readings never go backwards', async () => {
    const r = await api.post(`/api/v1/meters/${s.meter}/readings`).set(as('fm')).send({ reading: 105, readAt: '2026-09-05T10:00:00+05:30' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const back = await api.post(`/api/v1/meters/${s.meter}/readings`).set(as('fm')).send({ reading: 103, readAt: '2026-09-10T10:00:00+05:30' });
    assert.equal(back.status, 400);
    assert.match(back.body.error.message, /backwards/);
    const future = await api.post(`/api/v1/meters/${s.meter}/readings`).set(as('fm')).send({ reading: 200, readAt: '2030-01-01' });
    assert.equal(future.status, 400);
    assert.equal((await api.post(`/api/v1/meters/${s.meter}/readings`).set(as('r1')).send({ reading: 110 })).status, 403);

    const sheet = await api.get(`/api/v1/meters/sheet?block=${s.block}&period=2026-09`).set(as('fm'));
    assert.equal(sheet.status, 200);
    assert.equal(sheet.body.data[0].periodReading.reading, 105);
    const bulk = await api.post('/api/v1/meters/readings/bulk').set(as('fm')).send({ readAt: '2026-09-15T10:00:00+05:30', readings: [{ meter: s.meter, reading: 108 }, { meter: s.meter, reading: 1 }] });
    assert.equal(bulk.body.data.saved, 1);
    assert.equal(bulk.body.data.failed, 1);
  });

  test('device ingestion needs a key with meters:write', async () => {
    const key = await api.post('/api/v1/devices').set(as('admin')).send({ name: 'Water AMR', type: 'meter', scopes: ['meters:write'] });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const gateKey = await api.post('/api/v1/devices').set(as('admin')).send({ name: 'Gate cam', type: 'anpr', scopes: ['gate:events'] });
    const otherKey = await api.post('/api/v1/devices').set(as('other')).send({ name: 'Other AMR', type: 'meter', scopes: ['meters:write'] });
    const body = { serial: 'WM-101', reading: 112, readAt: '2026-09-25T06:00:00+05:30' };

    assert.equal((await api.post('/api/v1/meters/device-readings').send(body)).status, 401);
    assert.equal((await api.post('/api/v1/meters/device-readings').set('X-Device-Key', gateKey.body.data.key).send(body)).status, 403);
    const foreign = await api.post('/api/v1/meters/device-readings').set('X-Device-Key', otherKey.body.data.key).send(body);
    assert.equal(foreign.body.data.saved, 0, 'another society cannot write to this meter');

    const ok = await api.post('/api/v1/meters/device-readings').set('X-Device-Key', key.body.data.key).send(body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.saved, 1);
    const retry = await api.post('/api/v1/meters/device-readings').set('X-Device-Key', key.body.data.key).send({ readings: [body] });
    assert.equal(retry.body.data.saved, 1, 'same reading again is idempotent');
    const readings = await api.get(`/api/v1/meters/${s.meter}/readings`).set(as('r1'));
    assert.equal(readings.body.data[0].source, 'device');
    assert.equal(readings.body.meta.total, 3);
  });

  test('consumption feeds the bill as a metered line', async () => {
    const cons = await api.get('/api/v1/meters/consumption?period=2026-09').set(as('r1'));
    assert.equal(cons.body.data.length, 1);
    assert.equal(cons.body.data[0].consumption, 12);
    assert.equal(cons.body.data[0].estimatedCharge, 31000);
    assert.equal((await api.get('/api/v1/meters/consumption?period=2026-09').set(as('r2'))).body.data.length, 0);

    await generate('2026-09', ['A-101'], { dueDate: '2026-12-31' });
    const bill = await billFor('A-101', '2026-09');
    const water = bill.lines.find((l) => l.kind === 'metered');
    assert.equal(water.head, 'Water (12 kL)');
    assert.equal(water.amount, 31000); // 10 x ₹20 + 2 x ₹30 + ₹50 fixed
    assert.equal(water.account, '4000');
    assert.equal(bill.amount, 131000);
    assert.equal(bill.meters[0].from, 100);
    assert.equal(bill.meters[0].to, 112);

    const late = await api.post(`/api/v1/meters/${s.meter}/readings`).set(as('fm')).send({ reading: 113, readAt: '2026-09-20T10:00:00+05:30' });
    assert.equal(late.status, 409, 'billed period is closed');

    await generate('2026-10', ['A-101'], { dueDate: '2026-12-31' });
    const oct = await billFor('A-101', '2026-10');
    assert.equal(oct.lines.find((l) => l.kind === 'metered').amount, 5000, 'only the fixed charge without new readings');
  });

  test('Excel import and meter replacement', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Readings');
    ws.addRow(['Serial', 'Reading', 'Read on']);
    ws.addRow(['WM-101', 120, '2026-10-10']);
    ws.addRow(['NOPE-1', 5, '2026-10-10']);
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    const imp = await api.post('/api/v1/meters/readings/import').set(as('fm')).attach('file', file, 'readings.xlsx');
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.equal(imp.body.data.saved, 1);
    assert.equal(imp.body.data.failed, 1);

    const rep = await api.post(`/api/v1/meters/${s.meter}/replace`).set(as('fm')).send({ serial: 'WM-101B', finalReading: 125, initialReading: 0 });
    assert.equal(rep.status, 201, JSON.stringify(rep.body));
    const fresh = await api.post(`/api/v1/meters/${rep.body.data._id}/readings`).set(as('fm')).send({ reading: 1 });
    assert.equal(fresh.status, 201, 'new meter starts from its own initial reading');
    const old = await api.get(`/api/v1/meters/${s.meter}`).set(as('fm'));
    assert.equal(old.body.data.active, false);
  });
});

describe('autopay', () => {
  test('opt-in needs the society switch', async () => {
    assert.equal((await api.post('/api/v1/payments/autopay').set(as('r2')).send({ maxAmount: 200000 })).status, 409);
    await api.patch('/api/v1/finance/settings').set(as('accountant')).send({ autopayEnabled: true });
    const res = await api.post('/api/v1/payments/autopay').set(as('r2')).send({ maxAmount: 200000, method: 'upi' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'active');
    assert.equal(res.body.data.tokenId, undefined, 'token is never returned');
    const mine = await api.get('/api/v1/payments/autopay').set(as('r2'));
    assert.equal(mine.body.data.enabled, true);
    assert.equal(mine.body.data.mandate.maxAmount, 200000);
    const list = await api.get('/api/v1/payments/mandates').set(as('accountant'));
    assert.equal(list.body.data.length, 1);
    assert.equal((await api.get('/api/v1/payments/mandates').set(as('r2'))).status, 403);
  });

  test('new bills are charged through the mandate; failures notify', async () => {
    const gen = await generate('2026-11', ['A-102'], { dueDate: '2026-12-31' });
    assert.equal(gen.status, 201, JSON.stringify(gen.body));
    assert.deepEqual(gen.body.data.autopay, { charged: 1, pending: 0, failed: 0, skipped: 0 });
    const bill = await detail((await billFor('A-102', '2026-11'))._id);
    assert.equal(bill.status, 'paid');
    assert.equal(bill.payments[0].method, 'autopay');

    await Mandate.updateOne({ status: 'active' }, { tokenId: 'mock_tok_fail' });
    const gen2 = await generate('2026-12', ['A-102'], { dueDate: '2026-12-31' });
    assert.equal(gen2.body.data.autopay.failed, 1);
    assert.equal((await billFor('A-102', '2026-12')).status, 'unpaid');
    const notes = await api.get('/api/v1/notifications').set(as('r2'));
    assert.ok(notes.body.data.some((n) => /Autopay failed/.test(n.title)));

    const off = await api.delete('/api/v1/payments/autopay').set(as('r2'));
    assert.equal(off.body.data.status, 'cancelled');
  });
});

describe('online advance and receipts', () => {
  test('resident pays ahead online; receipts are private', async () => {
    const r = as('r1');
    const order = await api.post('/api/v1/payments/orders').set(r).send({ advance: 25000 });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    const signed = await api.post('/api/v1/payments/mock/sign').set(r).send({ orderId: order.body.data.orderId });
    const verify = await api.post('/api/v1/payments/verify').set(r).send(signed.body.data);
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    assert.equal(verify.body.data.purpose, 'advance');
    const receipt = await api.get(`/api/v1/payments/${verify.body.data._id}/receipt`).set(r);
    assert.equal(receipt.body.data.creditBalance, 25000);
    assert.equal((await api.get(`/api/v1/payments/${verify.body.data._id}/receipt`).set(as('r2'))).status, 404);
    const summary = await api.get('/api/v1/bills/summary').set(r);
    assert.equal(summary.body.data.advance, 25000);

    const applied = await api.post('/api/v1/bills/credits/apply').set(as('accountant')).send({ unit: u('A-101') });
    assert.equal(applied.body.data.applied, 25000);
    assert.equal(applied.body.data.creditBalance, 0);
  });
});

describe('tenant isolation', () => {
  test('another society sees none of this data', async () => {
    const o = as('other');
    assert.equal((await api.get(`/api/v1/bills/${s.julyA101}`).set(o)).status, 404);
    assert.equal((await api.get(`/api/v1/bills/${s.julyA101}/pdf`).set(o)).status, 404);
    assert.equal((await api.get(`/api/v1/bills/statement?unit=${u('A-101')}`).set(o)).status, 404);
    assert.equal((await api.get('/api/v1/bills/adjustments').set(o)).body.data.length, 0);
    assert.equal((await api.get('/api/v1/meters').set(o)).body.data.length, 0);
    assert.equal((await api.get(`/api/v1/meters/${s.meter}`).set(o)).status, 404);
    assert.equal((await api.post(`/api/v1/payments/${s.chequePayment}/bounce`).set(o).send({ reason: 'Nope nope' })).status, 404);
    assert.equal((await api.post('/api/v1/bills/refunds').set(o).send({ unit: u('A-201'), amount: 100, method: 'cash' })).status, 404);
    assert.equal((await api.post('/api/v1/meters').set(o).send({ unit: u('A-101'), type: 'gas', serial: 'GX-1' })).status, 400);
    assert.equal((await api.get('/api/v1/finance/settings').set(o)).body.data.gstEnabled, false);
    const waivers = await api.get('/api/v1/bills/waivers').set(o);
    assert.equal(waivers.body.data.length, 0);
    assert.equal((await api.get('/api/v1/bills/statement').set(as('r1'))).body.data.unit.label, 'A-101');
    assert.ok(s.otherUnit);
  });
});
