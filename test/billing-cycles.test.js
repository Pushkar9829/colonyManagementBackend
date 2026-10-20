import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
let svc;
let C;
let models;
const s = {};
const PASSWORD = 'Password@123';

const login = async (identifier) => {
  const res = await api.post('/api/v1/auth/login').send({ identifier, password: PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

async function newSociety(name, email, plan, units = 4) {
  const reg = await api.post('/api/v1/auth/register-society').send({ society: { name }, admin: { name: `${name} Admin`, email, password: PASSWORD } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const h = bearer(reg.body.data.accessToken);
  const block = await api.post('/api/v1/blocks').set(h).send({ name: 'A' });
  await api.post('/api/v1/units/bulk').set(h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: units, areaSqft: 900 });
  const id = reg.body.data.user.society._id;
  await models.Society.updateOne({ _id: id }, { plan: { name: plan, unitLimit: 500 } });
  return { h, id };
}

before(async () => {
  api = await setup();
  svc = await import('../src/modules/subscriptions/subscriptions.service.js');
  C = await import('../src/modules/subscriptions/subscriptions.constants.js');
  models = {
    User: (await import('../src/modules/users/user.model.js')).default,
    Society: (await import('../src/modules/society/society.model.js')).default,
    PlanPrice: (await import('../src/modules/subscriptions/planPrice.model.js')).default,
    PlatformInvoice: (await import('../src/modules/subscriptions/platformInvoice.model.js')).default,
    Subscription: (await import('../src/modules/subscriptions/subscription.model.js')).default,
  };
  await models.User.create({ name: 'Owner', email: 'owner@bc.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'super_admin' });
  s.p = bearer((await login('owner@bc.test')).accessToken);
  s.q = await newSociety('Quarter Court', 'q@bc.test', 'basic');
  s.y = await newSociety('Year Heights', 'y@bc.test', 'basic');
  s.o = await newSociety('Onetime Towers', 'o@bc.test', 'standard', 2);
  s.l = await newSociety('Lifetime Lane', 'l@bc.test', 'premium', 2);
});
after(teardown);

describe('pricing per cycle', () => {
  const price = { perUnitMonthly: 1000, flatMonthly: 50000, quarterlyDiscountPercent: 5, yearlyDiscountPercent: 10, oneTimePrice: 0, oneTimeValidityMonths: null };

  test('monthly, quarterly and yearly multiply the months and apply their own discount; GST 18% on top', () => {
    const m = svc.computeCharge({ units: 10, price, cycle: 'monthly' });
    assert.equal(m.months, 1);
    assert.equal(m.subtotal, 60000);
    assert.equal(m.gst, 10800);
    const q = svc.computeCharge({ units: 10, price, cycle: 'quarterly' });
    assert.equal(q.months, 3);
    assert.equal(q.discountPercent, 5);
    assert.equal(q.subtotal, 180000 - 9000);
    assert.equal(q.total, 171000 + Math.round(171000 * 0.18));
    assert.ok(q.lines.some((l) => /Quarterly billing discount 5%/.test(l.description) && l.amount === -9000));
    const y = svc.computeCharge({ units: 10, price, cycle: 'yearly' });
    assert.equal(y.months, 12);
    assert.equal(y.subtotal, 720000 - 72000);
  });

  test('one-time: a fixed price, not per unit, for a term or for life', () => {
    const term = svc.computeCharge({ units: 500, price: { ...price, oneTimePrice: 3000000, oneTimeValidityMonths: 24 }, cycle: 'one_time' });
    assert.equal(term.subtotal, 3000000);
    assert.equal(term.months, 24);
    assert.equal(term.lifetime, false);
    assert.equal(term.total, 3540000);
    const life = svc.computeCharge({ units: 5, price: { ...price, oneTimePrice: 5000000 }, cycle: 'one_time' });
    assert.equal(life.lifetime, true);
    assert.equal(life.months, 0);
    assert.equal(svc.periodEndFor(new Date(), life).getTime(), C.LIFETIME_UNTIL.getTime());
    assert.match(life.lines[0].description, /lifetime/);
  });

  test('period math: quarters follow calendar months in IST', () => {
    const start = new Date('2026-01-31T00:00:00+05:30');
    const end = svc.periodEndFor(start, { months: 3, lifetime: false });
    assert.equal(end.toISOString(), new Date('2026-04-30T00:00:00+05:30').toISOString());
  });

  test('the platform edits quarterly discount and one-time price; older price documents get the defaults', async () => {
    await models.PlanPrice.collection.insertOne({ plan: 'premium', perUnitMonthly: 3000, flatMonthly: 0, yearlyDiscountPercent: 20 }); // saved before quarterly existed
    const list = (await api.get('/api/v1/platform/plans').set(s.p)).body.data;
    const premium = list.find((p) => p.plan === 'premium');
    assert.equal(premium.quarterlyDiscountPercent, C.DEFAULT_PRICES.premium.quarterlyDiscountPercent);
    assert.equal(premium.yearlyDiscountPercent, 20);
    assert.deepEqual(premium.cycles, ['monthly', 'quarterly', 'yearly']);

    const upd = await api.put('/api/v1/platform/plans/standard').set(s.p).send({ quarterlyDiscountPercent: 7, oneTimePrice: 2400000, oneTimeValidityMonths: 36 });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.equal(upd.body.data.quarterlyDiscountPercent, 7);
    assert.deepEqual(upd.body.data.cycles, ['monthly', 'quarterly', 'yearly', 'one_time']);
    const life = await api.put('/api/v1/platform/plans/premium').set(s.p).send({ oneTimePrice: 9000000, oneTimeValidityMonths: null });
    assert.equal(life.body.data.oneTimeValidityMonths, null);
    assert.equal((await api.put('/api/v1/platform/plans/basic').set(s.p).send({ quarterlyDiscountPercent: 80 })).status, 422);
  });
});

describe('invoices for every cycle', () => {
  test('a society can pick quarterly; one-time only when its plan has a one-time price', async () => {
    const q = await api.patch('/api/v1/subscription').set(s.q.h).send({ billingCycle: 'quarterly' });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.data.nextInvoice.months, 3);
    assert.equal(q.body.data.cycleOptions.length, 4);
    assert.equal(q.body.data.cycleOptions.find((c) => c.cycle === 'one_time').available, false);
    const refused = await api.patch('/api/v1/subscription').set(s.y.h).send({ billingCycle: 'one_time' });
    assert.equal(refused.status, 400, 'basic has no one-time price');
    assert.equal((await api.patch('/api/v1/subscription').set(s.y.h).send({ billingCycle: 'yearly' })).status, 200);
    assert.equal((await api.patch('/api/v1/subscription').set(s.o.h).send({ billingCycle: 'one_time' })).status, 200);
    assert.equal((await api.patch(`/api/v1/platform/subscriptions/${s.l.id}`).set(s.p).send({ billingCycle: 'one_time' })).status, 200);
  });

  test('the billing job raises quarterly, yearly, fixed-term and lifetime invoices with the right periods', async () => {
    await svc.generateDueInvoices();
    const inv = async (soc) => models.PlatformInvoice.find({ society: soc.id }).sort({ periodStart: 1 }).lean();

    const [q] = await inv(s.q);
    assert.equal(q.billingCycle, 'quarterly');
    assert.equal(q.months, 3);
    assert.equal(q.discountPercent, 5);
    assert.equal(q.periodEnd.getTime(), svc.addLocalMonths(q.periodStart, 3).getTime());
    assert.equal(q.subtotal, 4 * 1000 * 3 - Math.round(4 * 1000 * 3 * 0.05));

    const [y] = await inv(s.y);
    assert.equal(y.months, 12);
    assert.equal(y.discountPercent, 10);

    const [o] = await inv(s.o);
    assert.equal(o.billingCycle, 'one_time');
    assert.equal(o.subtotal, 2400000, 'fixed price, not per unit');
    assert.equal(o.months, 36);
    assert.equal(o.periodEnd.getTime(), svc.addLocalMonths(o.periodStart, 36).getTime());

    const [l] = await inv(s.l);
    assert.equal(l.lifetime, true);
    assert.equal(l.subtotal, 9000000);
    assert.equal(l.periodEnd.getTime(), C.LIFETIME_UNTIL.getTime());

    // Proration-free: nothing new until a period ends; a lifetime licence is never billed again.
    const second = await svc.generateDueInvoices();
    assert.equal(second.created, 0);
    const farFuture = await svc.generateDueInvoices(new Date(Date.now() + 4 * 365 * 86400000));
    assert.ok(farFuture.created >= 3);
    assert.equal((await inv(s.l)).length, 1, 'lifetime: one invoice ever');
    assert.equal((await inv(s.o)).length, 2, 'fixed term renews with a new one-time invoice when it ends');
  });

  test('paying a lifetime invoice makes the society paid for life; dunning handles quarterly invoices', async () => {
    const [l] = await models.PlatformInvoice.find({ society: s.l.id }).lean();
    const paid = await api.post(`/api/v1/platform/invoices/${l._id}/mark-paid`).set(s.p).send({ method: 'bank', reference: 'NEFT-LIFE' });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    const sub = await models.Subscription.findOne({ society: s.l.id }).lean();
    assert.ok(C.isLifetime(sub.paidUntil));
    assert.ok(C.isLifetime((await models.Society.findById(s.l.id).lean()).plan.validUntil));

    const [q] = await models.PlatformInvoice.find({ society: s.q.id }).sort({ periodStart: 1 }).lean();
    const late = new Date(q.dueDate.getTime() + 30 * 86400000);
    const r = await svc.runDunning(late);
    assert.ok(r.suspended >= 1);
    assert.equal((await models.Society.findById(s.q.id).lean()).active, false);
  });

  test('a withdrawn one-time price falls back to monthly billing instead of a free lifetime', async () => {
    await api.put('/api/v1/platform/plans/standard').set(s.p).send({ oneTimePrice: 0 });
    const soc = await newSociety('Fallback Flats', 'f@bc.test', 'standard', 2);
    await models.Subscription.updateOne({ society: soc.id }, { billingCycle: 'one_time' }, { upsert: true });
    await svc.generateDueInvoices();
    const [inv] = await models.PlatformInvoice.find({ society: soc.id }).lean();
    assert.equal(inv.billingCycle, 'monthly');
    assert.equal(inv.months, 1);
  });
});
