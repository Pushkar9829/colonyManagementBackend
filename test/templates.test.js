import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';
import {
  BUTTON_STYLES, DEFAULT_PLAN_TEMPLATES, FONT_STYLES, FONTS, HEADER_STYLES, HOME_LAYOUTS, ICON_STYLES, LOGIN_LAYOUTS, RADII, RADIUS_SCALES,
  SHADES, SHADOW_STYLES, SIDEBAR_STYLES, TEMPLATES, TEMPLATE_KEYS,
} from '../src/modules/appearance/templates.catalogue.js';
import { contrast, resolvePalette, scaleFromColour } from '../src/modules/appearance/palette.js';

const V = '/api/v1';
const PASSWORD = 'Password@123';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
let api;
let models;
const s = {};

const ok = (res, status = 200) => assert.equal(res.status, status, JSON.stringify(res.body));
const login = async (identifier) => {
  const res = await api.post(`${V}/auth/login`).send({ identifier, password: PASSWORD });
  ok(res);
  return bearer(res.body.data.accessToken);
};
async function newSociety(name, email) {
  const reg = await api.post(`${V}/auth/register-society`).send({ society: { name }, admin: { name: `${name} Admin`, email, password: PASSWORD } });
  ok(reg, 201);
  const h = bearer(reg.body.data.accessToken);
  const block = await api.post(`${V}/blocks`).set(h).send({ name: 'A' });
  await api.post(`${V}/units/bulk`).set(h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 2, areaSqft: 900 });
  const units = (await api.get(`${V}/units`).set(h)).body.data;
  const id = reg.body.data.user.society._id;
  const society = await models.Society.findById(id).lean();
  return { h, id, code: society.code, units };
}
const setPlan = (soc, name) => models.Society.updateOne({ _id: soc.id }, { 'plan.name': name, 'plan.validUntil': null });
const platformRows = (action) => models.PlatformAudit.find({ action }).lean();

before(async () => {
  api = await setup();
  models = {
    User: (await import('../src/modules/users/user.model.js')).default,
    Society: (await import('../src/modules/society/society.model.js')).default,
    Reseller: (await import('../src/modules/whitelabel/reseller.model.js')).default,
    AuditLog: (await import('../src/modules/audit/audit.model.js')).default,
    PlatformAudit: (await import('../src/modules/platformTeam/platformAudit.model.js')).default,
  };
  s.A = await newSociety('Tpl Alpha', 'admin@tpla.test');
  s.B = await newSociety('Tpl Beta', 'admin@tplb.test');
  ok(await api.post(`${V}/users`).set(s.A.h).send({ name: 'Res Alpha', email: 'res@tpla.test', password: PASSWORD, role: 'resident', unit: s.A.units[0]._id, residentType: 'owner' }), 201);
  ok(await api.post(`${V}/users`).set(s.A.h).send({ name: 'Guard Alpha', email: 'guard@tpla.test', password: PASSWORD, role: 'guard' }), 201);
  s.resA = await login('res@tpla.test');
  s.guardA = await login('guard@tpla.test');

  const access = await import('../src/modules/platformTeam/access.js');
  await models.User.create({ name: 'Owner', email: 'owner@tpl.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'super_admin' });
  s.owner = await login('owner@tpl.test');
  for (const [key, email] of [['admin', 'padmin@tpl.test'], ['billing', 'billing@tpl.test'], ['viewer', 'viewer@tpl.test']]) {
    const role = await access.systemRole(key);
    await models.User.create({ name: key, email, passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'staff', platformRoleId: role._id, platformStatus: 'active' });
  }
  s.padmin = await login('padmin@tpl.test');
  s.billing = await login('billing@tpl.test');
  s.viewer = await login('viewer@tpl.test');
});
after(teardown);

describe('template catalogue', () => {
  test('10 templates with unique keys and every required field', () => {
    assert.equal(TEMPLATES.length, 10);
    assert.equal(new Set(TEMPLATE_KEYS).size, 10);
    for (const t of TEMPLATES) {
      for (const f of ['key', 'name', 'description', 'version']) assert.ok(t[f], `${t.key}.${f}`);
      assert.ok(t.tags.length >= 2, `${t.key} tags`);
      assert.deepEqual(Object.keys(t.palette.brand), SHADES, `${t.key} has the full 50–950 scale`);
      for (const c of [...Object.values(t.palette.brand), t.palette.accent, t.palette.successSurface, t.palette.warningSurface]) assert.match(c, /^#[0-9a-f]{6}$/);
      assert.ok(FONT_STYLES.includes(t.font) && FONTS[t.font], `${t.key} font`);
      assert.ok(RADIUS_SCALES.includes(t.radius) && RADII[t.radius], `${t.key} radius`);
      assert.ok(SHADOW_STYLES.includes(t.shadow), `${t.key} shadow`);
      assert.ok(HEADER_STYLES.includes(t.header), `${t.key} header`);
      assert.ok(SIDEBAR_STYLES.includes(t.sidebar), `${t.key} sidebar`);
      assert.ok(LOGIN_LAYOUTS.includes(t.login), `${t.key} login`);
      assert.ok(HOME_LAYOUTS.includes(t.home), `${t.key} home`);
      assert.ok(BUTTON_STYLES.includes(t.buttons), `${t.key} buttons`);
      assert.ok(ICON_STYLES.includes(t.icons), `${t.key} icons`);
      assert.equal(t.preview, `/templates/${t.key}.png`);
    }
    assert.equal(TEMPLATES[0].key, 'classic-blue');
    assert.ok(TEMPLATES.some((t) => t.darkFirst), 'one dark-first template');
  });

  test('all 4 home layouts and all 4 login layouts are used', () => {
    assert.deepEqual([...new Set(TEMPLATES.map((t) => t.home))].sort(), [...HOME_LAYOUTS].sort());
    assert.deepEqual([...new Set(TEMPLATES.map((t) => t.login))].sort(), [...LOGIN_LAYOUTS].sort());
    for (const list of [HEADER_STYLES, SIDEBAR_STYLES]) for (const v of list) assert.ok(TEMPLATES.some((t) => t.header === v || t.sidebar === v), v);
  });

  test('WCAG AA: brand-600 text on white, white on brand-600, active menu and brand sidebar text', () => {
    for (const t of TEMPLATES) {
      const b = t.palette.brand;
      assert.ok(contrast(b['600'], '#ffffff') >= 4.5, `${t.key}: brand-600 on white is ${contrast(b['600'], '#ffffff').toFixed(2)}`);
      assert.ok(contrast(b['700'], b['50']) >= 4.5, `${t.key}: brand-700 on brand-50`);
      assert.ok(contrast(b['100'], b['800']) >= 4.5, `${t.key}: brand-100 on brand-800 (brand sidebar)`);
    }
  });

  test('default plan allowance: trial/premium 10, standard 6, basic 3, free 1', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(DEFAULT_PLAN_TEMPLATES).map(([k, v]) => [k, v.length])), { trial: 10, free: 1, basic: 3, standard: 6, premium: 10 });
  });

  test('palette resolution: template palette unless the partner brand overrides it', () => {
    const t = TEMPLATES.find((x) => x.key === 'ocean-teal');
    const partner = { status: 'active', brand: { primaryColor: '#7a1fa2' }, templates: { brandOverridesTemplate: false } };
    assert.equal(resolvePalette(t, partner).brand['600'], t.palette.brand['600']);
    assert.equal(resolvePalette(t, partner, { loginWithoutSociety: true }).brand['600'], '#7a1fa2');
    const over = resolvePalette(t, { ...partner, templates: { brandOverridesTemplate: true } });
    assert.equal(over.source, 'reseller');
    assert.deepEqual(Object.keys(over.brand), SHADES);
    assert.equal(resolvePalette(t, { ...partner, status: 'suspended', templates: { brandOverridesTemplate: true } }).source, 'template');
    const generated = scaleFromColour('#0f766e');
    assert.ok(contrast(generated['50'], '#ffffff') < 1.2 && contrast(generated['950'], '#ffffff') > 10);
  });
});

describe('members and the colony admin', () => {
  test('every member reads the active template; a new colony starts on the default', async () => {
    for (const h of [s.A.h, s.resA, s.guardA]) {
      const res = await api.get(`${V}/appearance`).set(h);
      ok(res);
      assert.equal(res.body.data.template.key, 'classic-blue');
      assert.equal(res.body.data.template.palette.brand['600'], '#4f46e5');
      assert.equal(res.body.data.adminMayChange, true);
    }
    assert.equal((await api.get(`${V}/appearance`)).status, 401);
  });

  test('only the admin opens Settings → Appearance; trial offers all 10', async () => {
    assert.equal((await api.get(`${V}/appearance/options`).set(s.resA)).status, 403);
    assert.equal((await api.put(`${V}/appearance/template`).set(s.guardA).send({ template: 'green-garden' })).status, 403);
    const res = await api.get(`${V}/appearance/options`).set(s.A.h);
    ok(res);
    assert.equal(res.body.data.templates.length, 10);
    assert.ok(res.body.data.templates.every((t) => t.allowed));
  });

  test('plan rules limit the choice and say which plan unlocks a template', async () => {
    await setPlan(s.A, 'basic');
    const opts = (await api.get(`${V}/appearance/options`).set(s.A.h)).body.data;
    assert.deepEqual(opts.templates.filter((t) => t.allowed).map((t) => t.key).sort(), ['classic-blue', 'green-garden', 'slate-professional']);
    assert.equal(opts.templates.find((t) => t.key === 'ocean-teal').availableOn, 'standard');
    assert.equal(opts.templates.find((t) => t.key === 'night-sky').availableOn, 'premium');
    const denied = await api.put(`${V}/appearance/template`).set(s.A.h).send({ template: 'night-sky' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'TEMPLATE_NOT_ALLOWED');
    ok(await api.put(`${V}/appearance/template`).set(s.A.h).send({ template: 'green-garden' }));
    const mine = (await api.get(`${V}/appearance`).set(s.resA)).body.data;
    assert.equal(mine.template.key, 'green-garden');
    assert.equal(mine.template.home, 'tiles');
    const row = await models.AuditLog.findOne({ society: s.A.id, action: 'appearance.template_applied' }).lean();
    assert.deepEqual(row.meta, { from: 'classic-blue', to: 'green-garden' });
    // an unknown key is a validation error, not a 403
    assert.equal((await api.put(`${V}/appearance/template`).set(s.A.h).send({ template: 'neon' })).status, 422);
  });

  test('try-it preview returns the template without saving', async () => {
    const res = await api.get(`${V}/appearance/preview/royal-maroon`).set(s.A.h);
    ok(res);
    assert.equal(res.body.data.key, 'royal-maroon');
    assert.equal(res.body.data.login, 'full-cover');
    assert.equal((await api.get(`${V}/appearance`).set(s.A.h)).body.data.template.key, 'green-garden');
  });

  test('a downgraded plan falls back to an allowed template', async () => {
    await setPlan(s.A, 'free');
    assert.equal((await api.get(`${V}/appearance`).set(s.resA)).body.data.template.key, 'classic-blue');
    await setPlan(s.A, 'premium');
    assert.equal((await api.get(`${V}/appearance`).set(s.resA)).body.data.template.key, 'green-garden');
  });

  test('logo and cover photo come from the uploads service (own uploads only)', async () => {
    const up = await api.post(`${V}/uploads`).set(s.A.h).field('folder', 'appearance').attach('file', PNG, 'cover.png');
    ok(up, 201);
    const res = await api.patch(`${V}/appearance/media`).set(s.A.h).send({ cover: up.body.data._id, logo: up.body.data._id });
    ok(res);
    assert.equal(res.body.data.coverUrl, up.body.data.url);
    // a file uploaded in another society cannot be used
    const other = await api.post(`${V}/uploads`).set(s.B.h).field('folder', 'appearance').attach('file', PNG, 'b.png');
    assert.equal((await api.patch(`${V}/appearance/media`).set(s.A.h).send({ logo: other.body.data._id })).status, 400);
    ok(await api.patch(`${V}/appearance/media`).set(s.A.h).send({ logo: null }));
    const mine = (await api.get(`${V}/appearance`).set(s.resA)).body.data;
    assert.equal(mine.logoUrl, null);
    assert.equal(mine.coverUrl, up.body.data.url);
  });

  test('cross-society isolation: one colony’s choice never shows in another', async () => {
    const b = (await api.get(`${V}/appearance`).set(s.B.h)).body.data;
    assert.equal(b.template.key, 'classic-blue');
    assert.equal(b.coverUrl, null);
    assert.equal(b.society.code, s.B.code);
  });
});

describe('public appearance (login page)', () => {
  test('by society code shows that colony’s template, cover and name', async () => {
    const res = await api.get(`${V}/appearance/public`).query({ society: s.A.code.toLowerCase() });
    ok(res);
    assert.equal(res.body.data.template.key, 'green-garden');
    assert.equal(res.body.data.society.name, 'Tpl Alpha');
    assert.ok(res.body.data.society.coverUrl);
    assert.equal(res.body.data.brand.reseller, false);
  });

  test('unknown code or no code: the platform default', async () => {
    for (const q of [{ society: 'NOPE00' }, {}]) {
      const res = await api.get(`${V}/appearance/public`).query(q);
      ok(res);
      assert.equal(res.body.data.template.key, 'classic-blue');
      assert.equal(res.body.data.society, null);
    }
  });
});

describe('platform controls', () => {
  test('templates.manage: owner and admin roles have it, billing and viewer do not', async () => {
    ok(await api.get(`${V}/platform/templates`).set(s.owner));
    ok(await api.get(`${V}/platform/templates`).set(s.padmin));
    for (const h of [s.billing, s.viewer]) {
      assert.equal((await api.get(`${V}/platform/templates`).set(h)).status, 403);
      assert.equal((await api.patch(`${V}/platform/templates/night-sky`).set(h).send({ enabled: false })).status, 403);
    }
    assert.equal((await api.get(`${V}/platform/templates`).set(s.A.h)).status, 403);
    const perms = (await api.get(`${V}/platform/permissions`).set(s.owner)).body.data;
    assert.ok(JSON.stringify(perms).includes('templates.manage'));
  });

  test('overview has usage counts per template', async () => {
    const res = await api.get(`${V}/platform/templates`).set(s.owner);
    const by = Object.fromEntries(res.body.data.templates.map((t) => [t.key, t]));
    assert.equal(by['green-garden'].usage, 1);
    assert.equal(by['classic-blue'].usage, 1);
    assert.equal(by['classic-blue'].isDefault, true);
    assert.equal(res.body.data.planRules.standard.length, 6);
  });

  test('disable / default / plan rules, all audited', async () => {
    assert.equal((await api.patch(`${V}/platform/templates/classic-blue`).set(s.owner).send({ enabled: false })).status, 409);
    ok(await api.patch(`${V}/platform/templates/night-sky`).set(s.owner).send({ enabled: false }));
    let opts = (await api.get(`${V}/appearance/options`).set(s.A.h)).body.data;
    assert.ok(!opts.templates.some((t) => t.key === 'night-sky'));
    assert.equal((await api.put(`${V}/platform/templates/default`).set(s.owner).send({ template: 'night-sky' })).status, 409);
    ok(await api.patch(`${V}/platform/templates/night-sky`).set(s.owner).send({ enabled: true }));
    ok(await api.put(`${V}/platform/templates/default`).set(s.owner).send({ template: 'ocean-teal' }));
    assert.equal((await api.get(`${V}/appearance`).set(s.B.h)).body.data.template.key, 'ocean-teal');
    ok(await api.put(`${V}/platform/templates/default`).set(s.owner).send({ template: 'classic-blue' }));

    await setPlan(s.B, 'basic');
    ok(await api.put(`${V}/platform/templates/plans/basic`).set(s.owner).send({ templates: ['classic-blue', 'lavender-calm'] }));
    opts = (await api.get(`${V}/appearance/options`).set(s.B.h)).body.data;
    assert.deepEqual(opts.templates.filter((t) => t.allowed).map((t) => t.key).sort(), ['classic-blue', 'lavender-calm']);
    assert.equal((await api.put(`${V}/platform/templates/plans/basic`).set(s.owner).send({ templates: [] })).status, 422);
    assert.equal((await api.put(`${V}/platform/templates/plans/gold`).set(s.owner).send({ templates: ['classic-blue'] })).status, 422);

    await new Promise((r) => setTimeout(r, 50)); // audit rows are written after the response
    assert.equal((await platformRows('template.disabled')).length, 1);
    assert.equal((await platformRows('template.enabled')).length, 1);
    assert.equal((await platformRows('template.default_set')).length, 2);
    const rule = (await platformRows('template.plan_rule_changed'))[0];
    assert.deepEqual(rule.details, { plan: 'basic', templates: ['classic-blue', 'lavender-calm'] });
  });

  test('per colony: allowed override, admin-may-change switch and force', async () => {
    assert.equal((await api.patch(`${V}/platform/templates/societies/${s.B.id}`).set(s.billing).send({ adminMayChange: false })).status, 403);
    ok(await api.get(`${V}/platform/templates/societies/${s.B.id}`).set(s.viewer)); // societies.view may look
    let res = await api.patch(`${V}/platform/templates/societies/${s.B.id}`).set(s.owner).send({ allowedTemplates: ['sunrise-gradient', 'classic-blue'] });
    ok(res);
    assert.deepEqual(res.body.data.allowed.sort(), ['classic-blue', 'sunrise-gradient']);
    ok(await api.put(`${V}/appearance/template`).set(s.B.h).send({ template: 'sunrise-gradient' }));

    res = await api.patch(`${V}/platform/templates/societies/${s.B.id}`).set(s.owner).send({ adminMayChange: false, forceTemplate: 'night-sky' });
    ok(res);
    assert.equal(res.body.data.current, 'night-sky'); // forced even though the colony's list does not include it
    assert.equal(res.body.data.forced, true);
    const locked = await api.put(`${V}/appearance/template`).set(s.B.h).send({ template: 'classic-blue' });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.error.code, 'APPEARANCE_LOCKED');
    const mine = (await api.get(`${V}/appearance`).set(s.B.h)).body.data;
    assert.equal(mine.template.key, 'night-sky');
    assert.equal(mine.adminMayChange, false);

    // back to normal: the admin may change it again and the force flag clears on apply
    ok(await api.patch(`${V}/platform/templates/societies/${s.B.id}`).set(s.owner).send({ adminMayChange: true, allowedTemplates: [] }));
    ok(await api.put(`${V}/appearance/template`).set(s.B.h).send({ template: 'lavender-calm' }));
    res = await api.get(`${V}/platform/templates/societies/${s.B.id}`).set(s.owner);
    assert.equal(res.body.data.forced, false);
    assert.equal(res.body.data.current, 'lavender-calm');

    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await platformRows('society.template_forced')).length, 1);
    assert.ok((await platformRows('society.appearance_changed')).length >= 2);
    assert.ok(await models.AuditLog.exists({ society: s.B.id, action: 'platform.appearance_updated' }));
    // Alpha untouched
    assert.equal((await api.get(`${V}/appearance`).set(s.A.h)).body.data.template.key, 'green-garden');
  });

  test('reseller subset and brand override', async () => {
    const reseller = await models.Reseller.create({ name: 'NestCo', slug: 'nestco', brand: { appName: 'NestCo Living', primaryColor: '#7a1fa2' } });
    await models.Society.updateOne({ _id: s.A.id }, { reseller: reseller._id });
    await new Promise((r) => setTimeout(r, 10));

    assert.equal((await api.patch(`${V}/platform/templates/resellers/${reseller._id}`).set(s.billing).send({ brandOverridesTemplate: true })).status, 403);
    let res = await api.patch(`${V}/platform/templates/resellers/${reseller._id}`).set(s.owner).send({ allowedTemplates: ['ocean-teal', 'green-garden'] });
    ok(res);
    const opts = (await api.get(`${V}/appearance/options`).set(s.A.h)).body.data;
    assert.deepEqual(opts.templates.map((t) => t.key).sort(), ['green-garden', 'ocean-teal']);
    assert.equal((await api.put(`${V}/appearance/template`).set(s.A.h).send({ template: 'classic-blue' })).status, 403);

    // template palette until the override is switched on
    let mine = (await api.get(`${V}/appearance`).set(s.resA)).body.data;
    assert.equal(mine.template.palette.source, 'template');
    res = await api.patch(`${V}/platform/templates/resellers/${reseller._id}`).set(s.owner).send({ brandOverridesTemplate: true });
    ok(res);
    assert.equal(res.body.data.brandOverridesTemplate, true);
    mine = (await api.get(`${V}/appearance`).set(s.resA)).body.data;
    assert.equal(mine.template.key, 'green-garden');
    assert.equal(mine.template.palette.source, 'reseller');
    assert.equal(mine.template.palette.brand['600'], '#7a1fa2');

    // the partner's login page (no society): its subset and its colour
    const pub = (await api.get(`${V}/appearance/public`).query({ slug: 'nestco' })).body.data;
    assert.equal(pub.brand.appName, 'NestCo Living');
    assert.ok(['ocean-teal', 'green-garden'].includes(pub.template.key));
    assert.equal(pub.template.palette.brand['600'], '#7a1fa2');
    // Beta is not a partner colony: unaffected
    assert.equal((await api.get(`${V}/appearance`).set(s.B.h)).body.data.template.palette.source, 'template');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await platformRows('reseller.templates_changed')).length, 2);
  });
});
