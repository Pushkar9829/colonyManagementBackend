import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
let models;
const s = {};
const PASSWORD = 'Password@123';
const KEY_RX = /^CH-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

const loginRes = (identifier) => api.post('/api/v1/auth/login').send({ identifier, password: PASSWORD });
const login = async (identifier) => {
  const res = await loginRes(identifier);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return bearer(res.body.data.accessToken);
};
const register = (name, email, licenceKey) =>
  api.post('/api/v1/auth/register-society').send({ society: { name }, admin: { name: `${name} Admin`, email, password: PASSWORD }, ...(licenceKey ? { licenceKey } : {}) });

before(async () => {
  api = await setup();
  models = {
    User: (await import('../src/modules/users/user.model.js')).default,
    Society: (await import('../src/modules/society/society.model.js')).default,
    LicenceKey: (await import('../src/modules/whitelabel/licenceKey.model.js')).default,
    Subscription: (await import('../src/modules/subscriptions/subscription.model.js')).default,
  };
  await models.User.create({ name: 'Owner', email: 'owner@wl.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'super_admin' });
  s.owner = await login('owner@wl.test');
  const { ensureSystemRoles } = await import('../src/modules/platformTeam/access.js');
  const billing = (await ensureSystemRoles()).find((r) => r.key === 'billing');
  await models.User.create({ name: 'Billing', email: 'billing@wl.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'staff', platformRoleId: billing._id, platformStatus: 'active' });
  s.billing = await login('billing@wl.test');
});
after(teardown);

describe('resellers and key packs (platform)', () => {
  test('only whitelabel.manage may manage resellers', async () => {
    assert.equal((await api.get('/api/v1/platform/resellers').set(s.billing)).status, 403);
    const res = await api.post('/api/v1/platform/resellers').set(s.owner).send({
      name: 'SmartNest Homes',
      brand: { appName: 'SmartNest Living', primaryColor: '#0f766e', supportEmail: 'help@smartnest.test', customDomain: 'App.SmartNest.test' },
      contact: { name: 'Kavya', email: 'kavya@smartnest.test' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.slug, 'smartnest-homes');
    assert.equal(res.body.data.brand.customDomain, 'app.smartnest.test');
    s.r1 = res.body.data._id;
    const other = await api.post('/api/v1/platform/resellers').set(s.owner).send({ name: 'Other Partner', slug: 'otherp', brand: { appName: 'Other App' } });
    s.r2 = other.body.data._id;
    assert.equal((await api.post('/api/v1/platform/resellers').set(s.owner).send({ name: 'Clash', brand: { customDomain: 'app.smartnest.test' } })).status, 409);
    assert.equal((await api.post('/api/v1/platform/resellers').set(s.owner).send({ name: 'Bad colour', brand: { primaryColor: 'teal' } })).status, 422);
  });

  test('keys are shown once in full, stored hashed with the last 4 visible, and invoiced with GST', async () => {
    const gen = await api.post(`/api/v1/platform/resellers/${s.r1}/keys`).set(s.owner).send({ count: 5, plan: 'standard', cycle: 'yearly', pricePerKey: 1000000 });
    assert.equal(gen.status, 201, JSON.stringify(gen.body));
    assert.equal(gen.headers['cache-control'], 'no-store');
    const { keys, invoice } = gen.body.data;
    assert.equal(keys.length, 5);
    keys.forEach((k) => assert.match(k, KEY_RX));
    assert.equal(new Set(keys).size, 5);
    assert.match(invoice.number, /^PINV-\d{6}$/);
    assert.equal(invoice.subtotal, 5000000);
    assert.equal(invoice.gst, 900000);
    assert.equal(invoice.total, 5900000);
    s.keys = keys;

    const stored = await models.LicenceKey.find({ reseller: s.r1 }).select('+keyHash').lean();
    assert.equal(stored.length, 5);
    for (const doc of stored) {
      assert.ok(!keys.includes(doc.keyHash), 'never stored in plain text');
      assert.match(doc.keyHash, /^[0-9a-f]{64}$/);
    }
    const list = await api.get(`/api/v1/platform/resellers/${s.r1}/keys`).set(s.owner);
    const body = JSON.stringify(list.body);
    assert.equal(list.body.data.length, 5);
    assert.ok(keys.every((k) => !body.includes(k)), 'listing never shows full keys');
    assert.ok(!body.includes('keyHash'));
    assert.deepEqual(list.body.data.map((k) => k.last4).sort(), keys.map((k) => k.slice(-4)).sort());

    const life = await api.post(`/api/v1/platform/resellers/${s.r2}/keys`).set(s.owner).send({ count: 2, plan: 'premium', cycle: 'one_time', validityMonths: null });
    assert.equal(life.body.data.invoice, null, 'no invoice for free keys');
    s.lifeKeys = life.body.data.keys;
    const detail = await api.get(`/api/v1/platform/resellers/${s.r1}`).set(s.owner);
    assert.equal(detail.body.data.keysPurchased, 5);
    assert.deepEqual(detail.body.data.keys, { unused: 5, active: 0, revoked: 0 });

    const paid = await api.post(`/api/v1/platform/resellers/invoices/${invoice._id}/mark-paid`).set(s.owner).send({ method: 'bank', reference: 'NEFT-1' });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.status, 'paid');
  });
});

describe('activation', () => {
  test('registering with a key links the society to the reseller, sets the plan and prepays the term', async () => {
    const reg = await register('Lakeview', 'lake@wl.test', s.keys[0].toLowerCase().replace(/-/g, ' '));
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    s.lake = { id: reg.body.data.user.society._id, h: bearer(reg.body.data.accessToken) };
    const society = await models.Society.findById(s.lake.id).lean();
    assert.equal(String(society.reseller), s.r1);
    assert.equal(society.plan.name, 'standard');
    const sub = await models.Subscription.findOne({ society: s.lake.id }).lean();
    assert.equal(sub.billingCycle, 'yearly');
    const days = (sub.paidUntil - Date.now()) / 86400000;
    assert.ok(days > 360 && days < 370, `paid for a year (${days})`);
    assert.ok(sub.billedUntil >= sub.paidUntil, 'no invoices during the prepaid term');
    const key = await models.LicenceKey.findOne({ last4: s.keys[0].slice(-4), reseller: s.r1 }).lean();
    assert.equal(key.status, 'active');
    assert.equal(String(key.activatedSociety), s.lake.id);
    assert.equal(key.expiresAt.getTime(), sub.paidUntil.getTime());
  });

  test('a used, revoked or unknown key is refused and nothing is created', async () => {
    const reused = await register('Copycat', 'copy@wl.test', s.keys[0]);
    assert.equal(reused.status, 409);
    assert.equal(await models.User.exists({ email: 'copy@wl.test' }), null);
    assert.equal((await register('Ghost', 'ghost@wl.test', 'CH-2222-3333-4444')).status, 404);
    assert.equal((await register('Typo', 'typo@wl.test', 'not-a-key')).status, 400);
  });

  test('"Apply licence key" on the Subscription page (admin only)', async () => {
    const reg = await register('Orchid', 'orchid@wl.test');
    s.orchid = { id: reg.body.data.user.society._id, h: bearer(reg.body.data.accessToken) };
    await api.post('/api/v1/users').set(s.orchid.h).send({ name: 'Acc', email: 'acc@wl.test', password: PASSWORD, role: 'accountant' });
    const acc = await login('acc@wl.test');
    assert.equal((await api.post('/api/v1/licence/apply').set(acc).send({ key: s.keys[1] })).status, 403);
    const res = await api.post('/api/v1/licence/apply').set(s.orchid.h).send({ key: s.keys[1] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.plan, 'standard');
    assert.equal(res.body.data.brand.appName, 'SmartNest Living');
    // A key from another reseller cannot move a linked society to a different partner.
    const cross = await api.post('/api/v1/licence/apply').set(s.orchid.h).send({ key: s.lifeKeys[0] });
    assert.equal(cross.status, 409);
    // A lifetime key on an unlinked society: paid for life.
    const reg2 = await register('Forever Flats', 'forever@wl.test');
    const life = await api.post('/api/v1/licence/apply').set(bearer(reg2.body.data.accessToken)).send({ key: s.lifeKeys[0] });
    assert.equal(life.status, 200, JSON.stringify(life.body));
    assert.equal(life.body.data.lifetime, true);
  });
});

describe('reseller console', () => {
  test('the reseller admin logs in to a console scoped to their own reseller', async () => {
    const add = await api.post(`/api/v1/platform/resellers/${s.r1}/admins`).set(s.owner).send({ name: 'Kavya', email: 'reseller@wl.test', password: PASSWORD });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    await api.post(`/api/v1/platform/resellers/${s.r2}/admins`).set(s.owner).send({ name: 'Other', email: 'other@wl.test', password: PASSWORD });
    const res = await loginRes('reseller@wl.test');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.role, 'reseller_admin');
    assert.equal(res.body.data.user.platformPermissions, null);
    s.ra = bearer(res.body.data.accessToken);
    const refreshed = await api.post('/api/v1/auth/refresh').send({ refreshToken: res.body.data.refreshToken });
    assert.equal(refreshed.status, 200, 'sessions refresh');
    s.other = await login('other@wl.test');

    const home = await api.get('/api/v1/reseller').set(s.ra);
    assert.equal(home.status, 200);
    assert.equal(home.body.data.reseller.name, 'SmartNest Homes');
    assert.deepEqual(home.body.data.keys, { unused: 3, active: 2, revoked: 0 });
    assert.equal(home.body.data.societies, 2);
    const socs = await api.get('/api/v1/reseller/societies').set(s.ra);
    assert.deepEqual(socs.body.data.map((x) => x.name).sort(), ['Lakeview', 'Orchid']);
    assert.equal(socs.body.data[0].keys.length, 1);
    const unused = await api.get('/api/v1/reseller/keys?status=unused').set(s.ra);
    assert.equal(unused.body.data.length, 3);
    assert.equal((await api.get('/api/v1/reseller/invoices').set(s.ra)).body.data.length, 1);
  });

  test('revoke unused keys only; a revoked key cannot be activated', async () => {
    const keys = (await api.get('/api/v1/reseller/keys').set(s.ra)).body.data;
    const unusedKey = keys.find((k) => k.status === 'unused' && k.last4 === s.keys[2].slice(-4));
    const activeKey = keys.find((k) => k.status === 'active');
    const rev = await api.post(`/api/v1/reseller/keys/${unusedKey._id}/revoke`).set(s.ra);
    assert.equal(rev.status, 200);
    assert.equal(rev.body.data.status, 'revoked');
    assert.equal((await api.post(`/api/v1/reseller/keys/${activeKey._id}/revoke`).set(s.ra)).status, 409);
    const reg = await register('Late', 'late@wl.test');
    const apply = await api.post('/api/v1/licence/apply').set(bearer(reg.body.data.accessToken)).send({ key: s.keys[2] });
    assert.equal(apply.status, 409);
    assert.match(apply.body.error.message, /revoked/);
    // The platform can revoke too.
    const k4 = keys.find((k) => k.last4 === s.keys[3].slice(-4));
    assert.equal((await api.post(`/api/v1/platform/resellers/${s.r1}/keys/${k4._id}/revoke`).set(s.owner)).status, 200);
  });

  test('reseller admins cannot see other resellers or platform / society data', async () => {
    const theirs = (await api.get('/api/v1/reseller/keys').set(s.other)).body.data;
    assert.equal(theirs.length, 2);
    assert.ok(theirs.every((k) => String(k.reseller) === s.r2));
    const mineKey = (await api.get('/api/v1/reseller/keys?status=unused').set(s.ra)).body.data[0];
    assert.equal((await api.post(`/api/v1/reseller/keys/${mineKey._id}/revoke`).set(s.other)).status, 404, 'cannot touch another reseller’s key');
    for (const path of ['/api/v1/platform/resellers', '/api/v1/platform/societies', '/api/v1/platform/stats', `/api/v1/platform/payment-settings/${s.lake.id}`, '/api/v1/platform/invoices']) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await api.get(path).set(s.ra)).status, 403, path);
    }
    for (const path of ['/api/v1/units', '/api/v1/bills', '/api/v1/subscription', '/api/v1/payment-settings']) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await api.get(path).set(s.ra)).status, 403, path);
    }
    assert.equal((await api.get('/api/v1/reseller').set(s.lake.h)).status, 403, 'society admins are not reseller admins');
    assert.equal((await api.get('/api/v1/reseller').set(s.owner)).status, 403, 'nor is the platform owner');
  });
});

describe('branding', () => {
  test('login page brand by slug or custom domain host; ColonyHub otherwise', async () => {
    const bySlug = await api.get('/api/v1/branding?slug=smartnest-homes');
    assert.equal(bySlug.status, 200);
    assert.equal(bySlug.body.data.appName, 'SmartNest Living');
    assert.equal(bySlug.body.data.primaryColor, '#0f766e');
    const byHost = await api.get('/api/v1/branding').query({ host: 'APP.smartnest.test:443' });
    assert.equal(byHost.body.data.slug, 'smartnest-homes');
    const none = await api.get('/api/v1/branding').query({ host: 'colonyhub.vercel.app' });
    assert.equal(none.body.data.appName, 'ColonyHub');
    assert.equal(none.body.data.reseller, false);
  });

  test('a linked society sees the reseller brand in the app; suspending the reseller restores ColonyHub', async () => {
    const mine = await api.get('/api/v1/branding/society').set(s.lake.h);
    assert.equal(mine.body.data.appName, 'SmartNest Living');
    await api.patch(`/api/v1/platform/resellers/${s.r1}`).set(s.owner).send({ status: 'suspended' });
    assert.equal((await api.get('/api/v1/branding/society').set(s.lake.h)).body.data.appName, 'ColonyHub');
    assert.equal((await api.get('/api/v1/branding?slug=smartnest-homes')).body.data.appName, 'ColonyHub');
    await api.patch(`/api/v1/platform/resellers/${s.r1}`).set(s.owner).send({ status: 'active' });
  });

  test("society emails go out under the reseller's app name", async () => {
    const { email, sendEmailQuietly } = await import('../src/integrations/email.js');
    const sent = [];
    const original = email.send;
    email.send = async (msg) => {
      sent.push(msg);
    };
    try {
      sendEmailQuietly({ to: 'x@wl.test', subject: 'Hello', text: 'Hi', society: s.lake.id });
      sendEmailQuietly({ to: 'y@wl.test', subject: 'Plain', text: 'Hi' });
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      email.send = original;
    }
    assert.equal(sent.find((m) => m.to === 'x@wl.test').fromName, 'SmartNest Living');
    assert.equal(sent.find((m) => m.to === 'y@wl.test').fromName, undefined);
  });
});
