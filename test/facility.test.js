import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
const s = {};
const PW = 'Password@123';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

const ist = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const TODAY = ist();
const plusDays = (n) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const prevMonth = (() => {
  const [y, m] = TODAY.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
})();
const daysIn = (p) => {
  const [y, m] = p.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

const h = (who) => bearer(s[who].accessToken);
const get = (who, url, q) => api.get(`/api/v1${url}`).query(q || {}).set(h(who));
const post = (who, url, body) => api.post(`/api/v1${url}`).set(h(who)).send(body || {});
const patch = (who, url, body) => api.patch(`/api/v1${url}`).set(h(who)).send(body || {});
const put = (who, url, body) => api.put(`/api/v1${url}`).set(h(who)).send(body || {});
const okStatus = (res, code = 200) => assert.equal(res.status, code, JSON.stringify(res.body));

async function uploadAs(who, folder = 'staffhr') {
  const up = await api.post('/api/v1/uploads').set(h(who)).field('folder', folder).attach('file', PNG, 'proof.png');
  okStatus(up, 201);
  return up.body.data._id;
}

before(async () => {
  api = await setup();
  const reg = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Facility Heights' }, admin: { name: 'Admin FH', email: 'admin@fh.test', password: PW } });
  s.admin = reg.body.data;
  const block = await post('admin', '/blocks', { name: 'A' });
  await post('admin', '/units/bulk', { block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 1, areaSqft: 900 });
  const units = await get('admin', '/units');
  const people = [
    ['fm', { name: 'Fiona Manager', email: 'fm@fh.test', role: 'facility_manager' }],
    ['tech', { name: 'Tara Technician', email: 'tech@fh.test', role: 'staff', designation: 'Electrician' }],
    ['tech2', { name: 'Tom Technician', email: 'tech2@fh.test', role: 'staff' }],
    ['guard', { name: 'Gopal Guard', email: 'guard@fh.test', role: 'guard' }],
    ['acc', { name: 'Anu Accountant', email: 'acc@fh.test', role: 'accountant' }],
    ['res', { name: 'Ravi Resident', email: 'res@fh.test', role: 'resident', unit: units.body.data[0]._id, residentType: 'owner' }],
  ];
  for (const [, body] of people) {
    // eslint-disable-next-line no-await-in-loop
    okStatus(await post('admin', '/users', { ...body, password: PW }), 201);
  }
  const login = async (identifier) => (await api.post('/api/v1/auth/login').send({ identifier, password: PW })).body.data;
  for (const [key, body] of people) s[key] = await login(body.email); // eslint-disable-line no-await-in-loop

  const regB = await api.post('/api/v1/auth/register-society').send({ society: { name: 'Other Society' }, admin: { name: 'Admin B', email: 'admin@other.test', password: PW } });
  s.adminB = regB.body.data;
});
after(teardown);

describe('asset register', () => {
  test('creates assets with unique codes and enforces unique physical tags', async () => {
    const a = await post('fm', '/assets', { category: 'dg_set', name: 'DG Set 125 kVA', location: 'Basement', make: 'Kirloskar', purchaseCost: 150000000, tag: 'DG-01' });
    okStatus(a, 201);
    const b = await post('fm', '/assets', { category: 'lift', name: 'Lift A1', location: 'Tower A', warrantyExpiry: plusDays(30) });
    okStatus(b, 201);
    assert.match(a.body.data.code, /^AST-\d{6}$/);
    assert.notEqual(a.body.data.code, b.body.data.code);
    s.dg = a.body.data;
    s.lift = b.body.data;

    const dupTag = await post('fm', '/assets', { category: 'pump', name: 'Pump', tag: 'DG-01' });
    assert.equal(dupTag.status, 409);

    // QR lookup by generated code (case-insensitive) or by physical tag
    const byCode = await get('tech', `/assets/by-code/${s.dg.code.toLowerCase()}`);
    okStatus(byCode);
    assert.equal(byCode.body.data._id, s.dg._id);
    okStatus(await get('tech', '/assets/by-code/DG-01'));
    assert.equal((await get('tech', '/assets/by-code/AST-999999')).status, 404);
  });

  test('update, status change and the service-history timeline', async () => {
    okStatus(await patch('fm', `/assets/${s.dg._id}`, { model: 'KG1-125', notes: null }));
    okStatus(await post('fm', `/assets/${s.dg._id}/status`, { status: 'under_repair', note: 'Radiator leak' }));
    assert.equal((await post('fm', `/assets/${s.dg._id}/status`, { status: 'under_repair' })).status, 409);
    okStatus(await post('fm', `/assets/${s.dg._id}/status`, { status: 'working' }));
    okStatus(await post('tech', `/assets/${s.dg._id}/events`, { title: 'Topped up coolant', cost: 50000 }), 201);
    const tl = await get('tech', `/assets/${s.dg._id}/timeline`);
    okStatus(tl);
    const types = tl.body.data.map((e) => e.type);
    for (const t of ['created', 'updated', 'status_changed', 'service']) assert.ok(types.includes(t), t);
    const list = await get('fm', '/assets', { search: 'lift' });
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].warrantyStatus, 'expiring');
  });

  test('permissions: staff read-only, residents and other societies locked out', async () => {
    assert.equal((await post('tech', '/assets', { category: 'pump', name: 'Nope' })).status, 403);
    assert.equal((await get('res', '/assets')).status, 403);
    assert.equal((await get('guard', '/assets')).status, 403);
    assert.equal((await get('adminB', `/assets/${s.dg._id}`)).status, 404);
    const listB = await get('adminB', '/assets');
    assert.equal(listB.body.data.length, 0);
    assert.equal((await get('adminB', `/assets/by-code/${s.dg.code}`)).status, 404);
  });
});

describe('AMC, warranty and fire-safety alerts', () => {
  test('AMC contract, visit log and done-vs-due summary', async () => {
    const amc = await put('fm', `/assets/${s.dg._id}/amc`, { vendorName: 'PowerCare Services', contractNumber: 'AMC-77', startDate: plusDays(-358), endDate: plusDays(7), cost: 2400000, coverage: 'comprehensive', visitsPerYear: 4 });
    okStatus(amc);
    assert.equal(amc.body.data.amcStatus, 'expiring');
    okStatus(await post('fm', `/assets/${s.dg._id}/amc-visits`, { date: plusDays(-10), technician: 'Ramesh', findings: 'Serviced filters' }), 201);
    const detail = await get('fm', `/assets/${s.dg._id}`);
    assert.equal(detail.body.data.amcVisits.done, 1);
    assert.equal(detail.body.data.amcVisits.total, 4);
    assert.ok(detail.body.data.amcVisits.behind >= 2);
  });

  test('expiry job alerts managers once per threshold', async () => {
    const { amcWarrantyAlerts, fireSafetyAlerts } = await import('../src/modules/assets/assets.jobs.js');
    const first = await amcWarrantyAlerts();
    assert.equal(first.alerted, 2, 'AMC of the DG set (7 days) and warranty of the lift (30 days)');
    const again = await amcWarrantyAlerts();
    assert.equal(again.alerted, 0, 'never repeats the same reminder');
    const notes = await get('fm', '/notifications');
    assert.ok(notes.body.data.some((n) => n.title.startsWith('AMC for DG Set') && n.title.includes('7 day')));
    assert.ok(notes.body.data.some((n) => n.title.startsWith('Warranty for Lift A1')));
    const adminNotes = await get('admin', '/notifications');
    assert.ok(adminNotes.body.data.some((n) => n.title.startsWith('AMC for DG Set')));

    // renewing resets reminders for the new end date
    okStatus(await put('fm', `/assets/${s.dg._id}/amc`, { renew: true, vendorName: 'PowerCare Services', startDate: plusDays(8), endDate: plusDays(372), visitsPerYear: 4 }));
    assert.equal((await amcWarrantyAlerts()).alerted, 0, 'new contract is not within 30 days');

    const fe = await post('fm', '/fire-safety/extinguishers', { location: 'Lobby A', type: 'abc_powder', capacityKg: 6, nextRefillDue: plusDays(1) });
    okStatus(fe, 201);
    assert.equal(fe.body.data.state, 'due_soon');
    okStatus(await post('fm', '/fire-safety/nocs', { number: 'FNOC-2026-11', issuedBy: 'PMC Fire Brigade', issueDate: plusDays(-300), expiryDate: plusDays(25) }), 201);
    const fire = await fireSafetyAlerts();
    assert.equal(fire.alerted, 2);
    assert.equal((await fireSafetyAlerts()).alerted, 0);
    okStatus(await post('fm', '/fire-safety/drills', { date: TODAY, attendance: 42, evacuationMinutes: 6 }), 201);
    const summary = await get('fm', '/fire-safety/summary');
    assert.equal(summary.body.data.noc.number, 'FNOC-2026-11');
    assert.equal(summary.body.data.lastDrill.attendance, 42);
  });
});

describe('preventive maintenance', () => {
  test('schedule → tasks ahead of time → job is idempotent', async () => {
    const res = await post('fm', '/maintenance/schedules', {
      asset: s.dg._id,
      title: 'DG daily check',
      frequency: 'daily',
      startDate: TODAY,
      leadDays: 2,
      graceDays: 1,
      assigneeRole: 'staff',
      checklist: [
        { label: 'Oil level OK', type: 'yes_no' },
        { label: 'Battery voltage', type: 'reading', unit: 'V', min: 12, max: 14 },
        { label: 'Remarks', type: 'text', required: false },
      ],
    });
    okStatus(res, 201);
    assert.equal(res.body.data.tasksCreated, 3, 'today + 2 days of lead time');
    s.schedule = res.body.data;

    const { generatePpmTasks } = await import('../src/modules/maintenance/maintenance.jobs.js');
    const later = new Date(Date.now() + 5 * 86400000);
    const run1 = await generatePpmTasks(later);
    assert.equal(run1.created, 3);
    assert.equal((await generatePpmTasks(later)).created, 0);

    const monthly = await post('fm', '/maintenance/schedules', { asset: s.lift._id, title: 'Lift monthly service', frequency: 'monthly', startDate: '2026-01-31', leadDays: 30, assignee: s.tech.user._id });
    okStatus(monthly, 201);
    const { occurrences } = await import('../src/modules/maintenance/maintenance.service.js');
    assert.deepEqual(occurrences({ frequency: 'monthly', startDate: '2026-01-31' }, '2026-02-01', '2026-04-30'), ['2026-02-28', '2026-03-31', '2026-04-30']);
    assert.deepEqual(occurrences({ frequency: 'every_n_days', intervalDays: 10, startDate: '2026-01-01' }, '2026-01-15', '2026-02-01'), ['2026-01-21', '2026-01-31']);
  });

  test('staff completes a task: required answers, ranges and issues', async () => {
    const list = await get('tech', '/maintenance/tasks', { date: TODAY, schedule: s.schedule._id });
    okStatus(list);
    assert.equal(list.body.data.length, 1);
    const task = (await get('tech', `/maintenance/tasks/${list.body.data[0]._id}`)).body.data;
    const [oil, volts] = task.checklist;
    assert.equal((await get('guard', '/maintenance/tasks', { schedule: s.schedule._id })).body.data.length, 0, 'guards only see guard work');

    const missing = await post('tech', `/maintenance/tasks/${task._id}/complete`, { results: [{ itemId: oil._id, value: true }] });
    assert.equal(missing.status, 400);
    const photo = await uploadAs('tech', 'facility');
    const done = await post('tech', `/maintenance/tasks/${task._id}/complete`, { results: [{ itemId: oil._id, value: true }, { itemId: volts._id, value: 11.4 }], photos: [photo], remarks: 'Battery weak' });
    okStatus(done);
    assert.equal(done.body.data.status, 'completed');
    assert.equal(done.body.data.hasIssues, true);
    assert.equal(done.body.data.results.find((r) => r.label === 'Battery voltage').ok, false);
    assert.equal((await post('tech', `/maintenance/tasks/${task._id}/complete`, { results: [] })).status, 409);

    const far = await get('fm', '/maintenance/tasks', { schedule: s.schedule._id, date: plusDays(7) });
    const early = await post('fm', `/maintenance/tasks/${far.body.data[0]._id}/complete`, { results: [{ itemId: oil._id, value: true }, { itemId: volts._id, value: 13 }] });
    assert.equal(early.status, 409, 'too early');

    const tl = await get('fm', `/assets/${s.dg._id}/timeline`);
    assert.ok(tl.body.data.some((e) => e.type === 'ppm_completed'));
  });

  test('overdue detection then missed after grace', async () => {
    const { default: PpmTask } = await import('../src/modules/maintenance/ppmTask.model.js');
    const { sweepOverdue } = await import('../src/modules/maintenance/maintenance.service.js');
    const t = await PpmTask.findOne({ schedule: s.schedule._id, dueDate: plusDays(1) });
    await PpmTask.updateOne({ _id: t._id }, { dueDate: plusDays(-1), missAfter: plusDays(0) });
    const r1 = await sweepOverdue();
    assert.equal(r1.overdue, 1);
    assert.equal(r1.missed, 0);
    assert.equal((await PpmTask.findById(t._id)).status, 'overdue');
    const notes = await get('fm', '/notifications');
    assert.ok(notes.body.data.some((n) => /PPM task\(s\) overdue/.test(n.title)));
    const open = await get('tech', '/maintenance/tasks', { status: 'overdue' });
    assert.equal(open.body.data.length, 1);

    await PpmTask.updateOne({ _id: t._id }, { missAfter: plusDays(-1) });
    const r2 = await sweepOverdue();
    assert.equal(r2.missed, 1);
    assert.equal((await PpmTask.findById(t._id)).status, 'missed');

    const report = await get('fm', '/maintenance/reports/ppm', { from: plusDays(-5) });
    okStatus(report);
    const row = report.body.data.rows.find((x) => x.schedule === s.schedule._id);
    assert.equal(row.completed, 1);
    assert.equal(row.missed, 1);
    assert.equal(row.completionRate, 50);
  });

  test('breakdown → work order → technician completes → manager verifies', async () => {
    const bd = await post('tech', '/maintenance/breakdowns', { asset: s.lift._id, title: 'Lift stuck at 3rd floor', priority: 'urgent' });
    okStatus(bd, 201);
    assert.match(bd.body.data.number, /^BRK-/);
    assert.equal((await get('fm', `/assets/${s.lift._id}`)).body.data.status, 'under_repair');
    const badComplaint = await post('fm', '/maintenance/breakdowns', { asset: s.lift._id, title: 'Linked', complaint: s.dg._id });
    assert.equal(badComplaint.status, 400);

    const wo = await post('fm', '/work-orders', { title: 'Replace door sensor', breakdown: bd.body.data._id, vendorName: 'Otis Elevators', technician: s.tech.user._id, estimate: 850000 });
    okStatus(wo, 201);
    assert.equal(wo.body.data.source, 'breakdown');
    assert.equal(wo.body.data.asset._id, s.lift._id);
    assert.equal((await get('tech2', `/work-orders/${wo.body.data._id}`)).status, 404, 'other technicians cannot see it');
    assert.equal((await post('tech', `/work-orders/${wo.body.data._id}/status`, { status: 'completed' })).status, 400, 'proof required');
    okStatus(await post('tech', `/work-orders/${wo.body.data._id}/status`, { status: 'completed', note: 'Sensor replaced', actualCost: 800000 }));
    assert.equal((await post('tech', `/work-orders/${wo.body.data._id}/status`, { status: 'verified' })).status, 403);
    const verified = await post('fm', `/work-orders/${wo.body.data._id}/status`, { status: 'verified' });
    okStatus(verified);
    assert.equal(verified.body.data.actualCost, 800000);

    okStatus(await post('tech', `/maintenance/breakdowns/${bd.body.data._id}/status`, { status: 'resolved', resolution: 'Sensor replaced by Otis', cost: 800000 }));
    assert.equal((await get('fm', `/assets/${s.lift._id}`)).body.data.status, 'working');
    assert.equal((await get('res', '/work-orders')).status, 403);
  });
});

describe('housekeeping checklists', () => {
  test('runs are generated, need photo proof and supervisor verification', async () => {
    const cl = await post('fm', '/maintenance/checklists', { name: 'Lobby cleaning', area: 'lobby', items: [{ label: 'Floor mopped' }, { label: 'Glass wiped' }], slots: [{ label: 'Morning', dueBy: '23:59' }], requirePhoto: true });
    okStatus(cl, 201);
    const runs = await get('tech', '/maintenance/checklist-runs', { date: TODAY });
    okStatus(runs);
    const run = runs.body.data.find((r) => r.checklist === cl.body.data._id);
    assert.ok(run, 'today run generated');
    const items = run.items.map((i) => ({ itemId: i.itemId, done: true }));
    assert.equal((await post('tech', `/maintenance/checklist-runs/${run._id}/complete`, { items })).status, 400, 'photo required');
    const photo = await uploadAs('tech', 'facility');
    okStatus(await post('tech', `/maintenance/checklist-runs/${run._id}/complete`, { items, photos: [photo] }));
    const rejected = await post('fm', `/maintenance/checklist-runs/${run._id}/verify`, { approved: false, note: 'Glass still smudged' });
    assert.equal(rejected.body.data.status, 'rejected');
    const photo2 = await uploadAs('tech', 'facility');
    okStatus(await post('tech', `/maintenance/checklist-runs/${run._id}/complete`, { items, photos: [photo2] }));
    const ok = await post('fm', `/maintenance/checklist-runs/${run._id}/verify`, { approved: true });
    assert.equal(ok.body.data.status, 'verified');

    const { sweepMissed } = await import('../src/modules/maintenance/housekeeping.service.js');
    const swept = await sweepMissed(new Date(Date.now() + 3 * 86400000));
    assert.ok(swept.missed >= 1, "tomorrow's run is missed when nobody does it");
    const report = await get('fm', '/maintenance/checklist-runs/report', { from: TODAY, to: plusDays(1) });
    const row = report.body.data.rows.find((r) => r.checklist === cl.body.data._id);
    assert.equal(row.verified, 1);
    assert.equal(row.missed, 1);
  });
});

describe('inventory', () => {
  test('stock in/out, moving average cost, reorder alert and ledger', async () => {
    const item = await post('fm', '/inventory/items', { name: 'LED bulb 9W', category: 'electrical', unit: 'pcs', reorderLevel: 5, openingStock: 10, openingCost: 10000 });
    okStatus(item, 201);
    assert.equal(item.body.data.stock, 10);
    assert.equal(item.body.data.avgCost, 10000);
    const id = item.body.data._id;

    const inn = await post('fm', `/inventory/items/${id}/in`, { qty: 10, unitCost: 20000, vendorName: 'City Electricals', invoiceNumber: 'INV-55' });
    okStatus(inn, 201);
    assert.equal(inn.body.data.item.stock, 20);
    assert.equal(inn.body.data.item.avgCost, 15000);

    const out = await post('fm', `/inventory/items/${id}/out`, { qty: 16, issuedTo: s.tech.user._id, location: 'Tower A corridors' });
    okStatus(out, 201);
    assert.equal(out.body.data.item.stock, 4);
    assert.equal(out.body.data.lowStockAlert, true);
    assert.equal(out.body.data.movement.balanceAfter, 4);
    const notes = await get('fm', '/notifications');
    assert.ok(notes.body.data.some((n) => n.title === 'Low stock: LED bulb 9W'));

    assert.equal((await post('fm', `/inventory/items/${id}/out`, { qty: 10 })).status, 409, 'cannot issue more than in stock');
    assert.equal((await post('fm', `/inventory/items/${id}/out`, { qty: 1, issuedTo: s.res.user._id })).status, 400, 'residents are not staff');

    const { reorderAlerts } = await import('../src/modules/inventory/inventory.service.js');
    assert.equal((await reorderAlerts()).alerted, 0, 'already alerted on the issue');
    okStatus(await post('fm', '/inventory/items', { name: 'Floor cleaner', category: 'cleaning', unit: 'l', reorderLevel: 10 }), 201);
    assert.equal((await reorderAlerts()).alerted, 1);
    assert.equal((await reorderAlerts()).alerted, 0);

    const ledger = await get('fm', '/inventory/movements', { item: id });
    assert.deepEqual(ledger.body.data.map((m) => m.type).sort(), ['in', 'in', 'out']);
    const val = await get('fm', '/inventory/valuation');
    assert.equal(val.body.data.totalValue, 4 * 15000);
    assert.equal(val.body.data.lowStock, 2);
    const xlsx = await get('fm', '/inventory/export', { report: 'ledger' });
    okStatus(xlsx);
    assert.match(xlsx.headers['content-type'], /spreadsheetml/);
    assert.equal((await post('tech', `/inventory/items/${id}/in`, { qty: 1, unitCost: 1 })).status, 403);
    assert.equal((await get('adminB', `/inventory/items/${id}`)).status, 404);
  });
});

describe('utility logs', () => {
  test('DG diesel stock, meter consumption and summaries', async () => {
    const dg = await post('fm', '/utility-logs/points', { kind: 'dg', name: 'DG 1', capacity: 200, openingDieselStock: 100, openingHours: 10 });
    okStatus(dg, 201);
    const r1 = await post('guard', '/utility-logs/readings', { point: dg.body.data._id, shift: 'morning', hoursEnd: 12.5, dieselConsumed: 30 });
    okStatus(r1, 201);
    assert.equal(r1.body.data.runHours, 2.5);
    assert.equal(r1.body.data.dieselStock, 70);
    assert.equal((await post('guard', '/utility-logs/readings', { point: dg.body.data._id, dieselConsumed: 100 })).status, 409);

    const meter = await post('fm', '/utility-logs/points', { kind: 'meter', name: 'Common area meter', openingMeterReading: 1000 });
    okStatus(await post('tech', '/utility-logs/readings', { point: meter.body.data._id, meterReading: 1100 }), 201);
    assert.equal((await post('tech', '/utility-logs/readings', { point: meter.body.data._id, meterReading: 1050 })).status, 400);

    const stp = await post('fm', '/utility-logs/points', { kind: 'stp', name: 'STP 1' });
    assert.ok(stp.body.data.parameters.some((p) => p.key === 'ph'), 'default parameters');
    const bad = await post('tech', '/utility-logs/readings', { point: stp.body.data._id, values: [{ key: 'ph', value: 9.6 }, { key: 'bod', value: 12 }] });
    assert.equal(bad.body.data.outOfRange, true);

    const sum = await get('fm', '/utility-logs/summary', { kind: 'dg' });
    okStatus(sum);
    assert.equal(sum.body.data.rows[0].runHours, 2.5);
    assert.equal(sum.body.data.rows[0].closingStock, 70);
    const xlsx = await get('fm', '/utility-logs/export', { kind: 'stp', groupBy: 'month' });
    okStatus(xlsx);
    assert.equal((await get('res', '/utility-logs/points')).status, 403);
  });
});

describe('staff HR: employees and attendance', () => {
  test('employee profiles from staff memberships, bank details masked', async () => {
    const cands = await get('fm', '/staffhr/employees/candidates');
    okStatus(cands);
    const m = (email) => cands.body.data.find((c) => c.user.email === email).membership;
    assert.ok(!cands.body.data.some((c) => c.user.email === 'res@fh.test'), 'residents are not candidates');
    const shift = await post('fm', '/staffhr/shifts', { name: 'General', start: '00:00', end: '23:59' });
    okStatus(shift, 201);
    s.shift = shift.body.data;
    const tech = await post('fm', '/staffhr/employees', {
      membership: m('tech@fh.test'),
      designation: 'Electrician',
      department: 'maintenance',
      dateOfJoining: '2025-01-01',
      defaultShift: s.shift._id,
      salary: { basic: 1200000, hra: 300000, allowances: [{ name: 'Conveyance', amount: 200000 }], pfPercent: 12, esiPercent: 0.75, professionalTax: 20000 },
      bank: { accountName: 'Tara T', accountNumber: '123456789012', ifsc: 'HDFC0001234', bankName: 'HDFC' },
    });
    okStatus(tech, 201);
    assert.match(tech.body.data.employeeCode, /^EMP-\d{4}$/);
    assert.equal(tech.body.data.bank.accountLast4, '9012');
    assert.equal(tech.body.data.bank.accountNumber, undefined, 'full number never returned');
    s.techEmp = tech.body.data;
    const guard = await post('fm', '/staffhr/employees', { membership: m('guard@fh.test'), employeeCode: 'G-01', department: 'security', dateOfJoining: '2025-06-01', salary: { basic: 1500000 } });
    okStatus(guard, 201);
    s.guardEmp = guard.body.data;
    assert.equal((await post('fm', '/staffhr/employees', { membership: m('guard@fh.test') })).status, 409);
    const bank = await get('acc', `/staffhr/employees/${s.techEmp._id}/bank`);
    assert.equal(bank.body.data.accountNumber, '123456789012');
    assert.equal((await get('fm', `/staffhr/employees/${s.techEmp._id}/bank`)).status, 403);
    assert.equal((await get('tech', '/staffhr/employees')).status, 403);
    assert.equal((await get('tech', '/staffhr/employees/me')).body.data.employeeCode, s.techEmp.employeeCode);
  });

  test('self check-in with selfie and geofence accept / reject', async () => {
    okStatus(await patch('fm', '/staffhr/settings', { geofence: { enabled: true, lat: 18.559, lng: 73.7868, radiusM: 200 }, requireSelfie: true }));
    const photo = await uploadAs('tech');
    assert.equal((await post('tech', '/staffhr/attendance/check-in', { lat: 18.5591, lng: 73.7869 })).status, 400, 'selfie required');
    assert.equal((await post('tech', '/staffhr/attendance/check-in', { photo })).status, 400, 'location required');
    const far = await post('tech', '/staffhr/attendance/check-in', { photo, lat: 18.6, lng: 73.8 });
    assert.equal(far.status, 403);
    assert.equal(far.body.error.code, 'OUTSIDE_GEOFENCE');
    const inside = await post('tech', '/staffhr/attendance/check-in', { photo, lat: 18.5594, lng: 73.787, accuracy: 15 });
    okStatus(inside, 201);
    assert.ok(['present', 'late'].includes(inside.body.data.status));
    assert.ok(inside.body.data.checkIn.distanceM < 200);
    assert.ok(inside.body.data.checkIn.photo.url);
    assert.equal((await post('tech', '/staffhr/attendance/check-in', { photo, lat: 18.5594, lng: 73.787 })).status, 409);
    const photo2 = await uploadAs('tech');
    const out = await post('tech', '/staffhr/attendance/check-out', { photo: photo2, lat: 18.5594, lng: 73.787 });
    okStatus(out);
    assert.equal(out.body.data.status, 'half_day', 'a few seconds of work is under the half-day threshold');
    const today = await get('tech', '/staffhr/attendance/today');
    assert.ok(today.body.data.record.checkOut);
    assert.equal((await post('res', '/staffhr/attendance/check-in', { photo })).status, 403);
  });

  test('device punches need a key with the attendance scope', async () => {
    const key = await post('admin', '/devices', { name: 'Gate biometric', type: 'biometric', scopes: ['attendance:write'] });
    okStatus(key, 201);
    const wrong = await post('admin', '/devices', { name: 'ANPR', type: 'anpr', scopes: ['gate:events'] });
    const body = { punches: [{ employeeCode: 'g-01', at: new Date(Date.now() - 60000).toISOString() }, { employeeCode: 'NOPE', at: new Date().toISOString() }] };
    assert.equal((await api.post('/api/v1/staffhr/device-punches').send(body)).status, 401);
    assert.equal((await api.post('/api/v1/staffhr/device-punches').set('X-Device-Key', wrong.body.data.key).send(body)).status, 403);
    const res = await api.post('/api/v1/staffhr/device-punches').set('X-Device-Key', key.body.data.key).send(body);
    okStatus(res);
    assert.equal(res.body.data.accepted, 1);
    assert.equal(res.body.data.rejected, 1);
    assert.equal(res.body.data.results.find((r) => r.employeeCode === 'g-01').action, 'check_in');
    const again = await api.post('/api/v1/staffhr/device-punches').set('X-Device-Key', key.body.data.key).send({ punches: [{ employeeCode: 'G-01', at: new Date().toISOString() }] });
    assert.equal(again.body.data.results[0].action, 'check_out');
    const day = await get('fm', '/staffhr/attendance/day');
    const g = day.body.data.rows.find((r) => r.employee.employeeCode === 'G-01');
    assert.equal(g.record.checkIn.source, 'device');
    // a device key of another society never reaches this one's employees
    const keyB = await post('adminB', '/devices', { name: 'B terminal', scopes: ['attendance:write'] });
    const cross = await api.post('/api/v1/staffhr/device-punches').set('X-Device-Key', keyB.body.data.key).send({ punches: [{ employeeCode: 'G-01', at: new Date().toISOString() }] });
    assert.equal(cross.body.data.accepted, 0);
  });

  test('absence job marks yesterday no-shows', async () => {
    const { markAbsences } = await import('../src/modules/staffhr/attendance.service.js');
    const r = await markAbsences(new Date(Date.now() + 86400000)); // "yesterday" = today; both already punched
    assert.equal(r.absent, 0);
    const r2 = await markAbsences(new Date(Date.now() + 2 * 86400000)); // tomorrow: nobody punched
    assert.equal(r2.absent + r2.weekOff, 2);
    assert.equal((await markAbsences(new Date(Date.now() + 2 * 86400000))).absent, 0, 'idempotent');
  });
});

describe('staff HR: leave', () => {
  test('apply, balance, approve, over-balance and overlap rules', async () => {
    const from = plusDays(40);
    const to = plusDays(41);
    const year = Number(from.slice(0, 4));
    const apply = await post('tech', '/staffhr/leaves', { type: 'casual', from, to, reason: 'Family function' });
    okStatus(apply, 201);
    assert.equal(apply.body.data.days, 2);
    let bal = await get('tech', '/staffhr/leaves/balances', { year });
    let casual = bal.body.data.balances.find((b) => b.type === 'casual');
    assert.deepEqual([casual.allocated, casual.pending, casual.available], [12, 2, 10]);

    assert.equal((await post('tech', '/staffhr/leaves', { type: 'sick', from: to, to: plusDays(43) })).status, 409, 'overlap');
    assert.equal((await post('tech', `/staffhr/leaves/${apply.body.data._id}/decide`, { approved: true })).status, 403);
    const ok = await post('fm', `/staffhr/leaves/${apply.body.data._id}/decide`, { approved: true });
    assert.equal(ok.body.data.status, 'approved');
    bal = await get('tech', '/staffhr/leaves/balances', { year });
    casual = bal.body.data.balances.find((b) => b.type === 'casual');
    assert.deepEqual([casual.used, casual.pending, casual.available], [2, 0, 10]);

    const tooMuch = await post('tech', '/staffhr/leaves', { type: 'casual', from: plusDays(50), to: plusDays(60) });
    assert.equal(tooMuch.status, 409, '11 days > 10 left');
    const half = await post('guard', '/staffhr/leaves', { type: 'sick', from: plusDays(45), to: plusDays(45), halfDay: true });
    assert.equal(half.body.data.days, 0.5);
    okStatus(await post('guard', `/staffhr/leaves/${half.body.data._id}/cancel`));
    assert.equal((await post('res', '/staffhr/leaves', { type: 'casual', from, to })).status, 403);
    const cal = await get('fm', '/staffhr/leaves/calendar', { period: from.slice(0, 7) });
    assert.ok(cal.body.data.some((l) => l._id === apply.body.data._id));
    const mine = await get('guard', '/staffhr/leaves');
    assert.ok(mine.body.data.every((l) => l.user === s.guard.user._id));
  });
});

describe('staff HR: payroll', () => {
  test('payroll run computes LOP, statutory deductions, advances and net', async () => {
    const d = (n) => `${prevMonth}-${String(n).padStart(2, '0')}`;
    for (const day of [3, 4]) okStatus(await post('fm', '/staffhr/attendance/mark', { employee: s.techEmp._id, date: d(day), status: 'absent' })); // eslint-disable-line no-await-in-loop
    okStatus(await post('fm', '/staffhr/attendance/mark', { employee: s.techEmp._id, date: d(5), status: 'half_day', checkIn: '09:00', checkOut: '12:00' }));
    const unpaid = await post('fm', '/staffhr/leaves', { employee: s.techEmp._id, type: 'unpaid', from: d(6), to: d(6) });
    assert.equal(unpaid.body.data.status, 'approved', 'manager-filed leave is approved at once');
    okStatus(await post('fm', '/staffhr/advances', { employee: s.techEmp._id, amount: 500000, installment: 100000, date: d(1) }), 201);

    const run = await post('fm', '/staffhr/payroll-runs', { period: prevMonth });
    okStatus(run, 201);
    assert.equal((await post('fm', '/staffhr/payroll-runs', { period: prevMonth })).status, 409);
    const slip = run.body.data.payslips.find((p) => p.employee === s.techEmp._id);
    const D = daysIn(prevMonth);
    const paidDays = D - 3.5;
    const pr = (x) => Math.round((x * paidDays) / D);
    const basic = pr(1200000);
    const gross = basic + pr(300000) + pr(200000);
    const pf = Math.round((Math.min(basic, 1500000) * 12) / 100);
    const esi = Math.round((gross * 0.75) / 100);
    assert.equal(slip.lopDays, 3.5);
    assert.equal(slip.paidDays, paidDays);
    assert.equal(slip.gross, gross);
    assert.equal(slip.deductionLines.find((x) => x.head === 'Provident fund').amount, pf);
    assert.equal(slip.deductionLines.find((x) => x.head === 'ESI').amount, esi);
    assert.equal(slip.deductionLines.find((x) => x.head === 'Professional tax').amount, 20000);
    assert.equal(slip.deductionLines.find((x) => x.head === 'Salary advance').amount, 100000);
    assert.equal(slip.net, gross - pf - esi - 20000 - 100000);
    assert.equal(slip.status, 'draft');
    s.slip = slip;
    s.run = run.body.data;
    const guardSlip = run.body.data.payslips.find((p) => p.employee === s.guardEmp._id);
    assert.equal(guardSlip.lopDays, 0);
    assert.equal(guardSlip.gross, 1500000);

    // bonus adjustment on the draft
    const adj = await patch('fm', `/staffhr/payslips/${slip._id}/adjustments`, { adjustments: [{ head: 'Diwali bonus', amount: 300000, kind: 'earning' }] });
    okStatus(adj);
    assert.equal(adj.body.data.gross, gross + 300000);

    // drafts are not visible to the employee
    assert.equal((await get('tech', '/staffhr/payslips')).body.data.length, 0);
    assert.equal((await post('acc', `/staffhr/payslips/${slip._id}/pay`, { method: 'bank' })).status, 409, 'approve first');
    assert.equal((await post('acc', `/staffhr/payroll-runs/${s.run._id}/approve`)).status, 403, 'accountants do not approve');
    const approved = await post('fm', `/staffhr/payroll-runs/${s.run._id}/approve`);
    okStatus(approved);
    assert.equal(approved.body.data.status, 'approved');
    const advances = await get('acc', '/staffhr/advances', { employee: s.techEmp._id });
    assert.equal(advances.body.data[0].recovered, 100000);
    const runs = await get('acc', '/staffhr/payroll-runs');
    assert.equal(runs.body.data[0].period, prevMonth);
  });

  test('payslip permissions: staff see only their own; accountant marks paid', async () => {
    const mine = await get('tech', '/staffhr/payslips');
    okStatus(mine);
    assert.equal(mine.body.data.length, 1);
    assert.equal(mine.body.data[0]._id, s.slip._id);
    const guardSlip = s.run.payslips.find((p) => p.employee === s.guardEmp._id);
    assert.equal((await get('tech', `/staffhr/payslips/${guardSlip._id}`)).status, 404);
    assert.equal((await get('tech', `/staffhr/payslips/${guardSlip._id}/pdf`)).status, 404);
    const pdf = await get('tech', `/staffhr/payslips/${s.slip._id}/pdf`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    okStatus(pdf);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await post('tech', `/staffhr/payslips/${s.slip._id}/pay`, { method: 'bank' })).status, 403);
    const paid = await post('acc', `/staffhr/payslips/${s.slip._id}/pay`, { method: 'bank', reference: 'NEFT-001' });
    okStatus(paid);
    assert.equal(paid.body.data.status, 'paid');
    assert.equal((await post('acc', `/staffhr/payslips/${s.slip._id}/pay`, { method: 'bank' })).status, 409);
    const rest = await post('acc', `/staffhr/payroll-runs/${s.run._id}/pay`, { method: 'cash' });
    assert.equal(rest.body.data.status, 'paid');
    assert.equal((await get('res', '/staffhr/payslips')).status, 403);
    assert.equal((await get('res', '/staffhr/leaves')).status, 403);
    const xlsx = await get('acc', `/staffhr/payroll-runs/${s.run._id}/export`);
    okStatus(xlsx);
    const reg = await get('acc', '/staffhr/attendance/register', { period: prevMonth });
    const row = reg.body.data.rows.find((r) => r.employee._id === s.techEmp._id);
    assert.equal(row.days[2], 'A');
    assert.equal(row.days[5], 'LOP');
  });

  test('tenant isolation for HR data', async () => {
    assert.equal((await get('adminB', `/staffhr/payslips/${s.slip._id}`)).status, 404);
    assert.equal((await get('adminB', `/staffhr/employees/${s.techEmp._id}`)).status, 404);
    assert.equal((await get('adminB', '/staffhr/employees')).body.data.length, 0);
    assert.equal((await get('adminB', '/staffhr/payroll-runs')).body.data.length, 0);
    assert.equal((await get('adminB', '/maintenance/tasks')).body.data.length, 0);
    assert.equal((await get('adminB', '/inventory/items')).body.data.length, 0);
    assert.equal((await get('adminB', '/utility-logs/readings')).body.data.length, 0);
  });
});
