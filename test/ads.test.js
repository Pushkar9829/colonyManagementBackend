import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

const V = '/api/v1';
const PASSWORD = 'Password@123';
let api;
let models;
const s = {};

const ok = (res, status = 200) => assert.equal(res.status, status, `${res.req?.method} ${res.req?.path}: ${JSON.stringify(res.body)}`);
const login = async (identifier) => {
  const res = await api.post(`${V}/auth/login`).send({ identifier, password: PASSWORD });
  ok(res);
  return bearer(res.body.data.accessToken);
};
const DAY = 86400000;
const window = (fromDays = -1, toDays = 7) => ({ startAt: new Date(Date.now() + fromDays * DAY).toISOString(), endAt: new Date(Date.now() + toDays * DAY).toISOString() });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64, 2)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 3)]);

const upload = (h, path, buf, name) => api.post(`${V}/ads/${path}/media`).set(h).attach('file', buf, name);
async function media(h, path, buf = PNG, name = 'ad.png') {
  const res = await upload(h, path, buf, name);
  ok(res, 201);
  return res.body.data._id;
}
// Builds the body (which may await an upload) before the request starts.
const postAd = (h, path, body) => api.post(`${V}/ads/${path}`).set(h).send(body);
const active = async (h) => {
  const res = await api.get(`${V}/ads/active`).set(h);
  ok(res);
  return res.body.data;
};
const bannerTitles = async (h) => (await active(h)).banners.map((b) => b.title);

async function newSociety(name, email) {
  const reg = await api.post(`${V}/auth/register-society`).send({ society: { name }, admin: { name: `${name} Admin`, email, password: PASSWORD } });
  ok(reg, 201);
  const h = bearer(reg.body.data.accessToken);
  const block = await api.post(`${V}/blocks`).set(h).send({ name: 'A' });
  await api.post(`${V}/units/bulk`).set(h).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 2, areaSqft: 900 });
  const units = (await api.get(`${V}/units`).set(h)).body.data;
  return { h, id: reg.body.data.user.society._id, units };
}
async function member(soc, body) {
  ok(await api.post(`${V}/users`).set(soc.h).send({ password: PASSWORD, ...body }), 201);
  return login(body.email);
}

before(async () => {
  api = await setup();
  models = {
    User: (await import('../src/modules/users/user.model.js')).default,
    AdSeen: (await import('../src/modules/ads/adSeen.model.js')).default,
    AuditLog: (await import('../src/modules/audit/audit.model.js')).default,
  };
  const access = await import('../src/modules/platformTeam/access.js');
  s.A = await newSociety('Ads Alpha', 'admin@alpha.test');
  s.B = await newSociety('Ads Beta', 'admin@beta.test');
  s.resA = await member(s.A, { name: 'Res Alpha', email: 'res@alpha.test', role: 'resident', unit: s.A.units[0]._id, residentType: 'owner' });
  s.guardA = await member(s.A, { name: 'Guard Alpha', email: 'guard@alpha.test', role: 'guard' });
  s.fmA = await member(s.A, { name: 'FM Alpha', email: 'fm@alpha.test', role: 'facility_manager' });
  s.accA = await member(s.A, { name: 'Acc Alpha', email: 'acc@alpha.test', role: 'accountant' });
  s.resB = await member(s.B, { name: 'Res Beta', email: 'res@beta.test', role: 'resident', unit: s.B.units[0]._id, residentType: 'owner' });

  await models.User.create({ name: 'Owner', email: 'owner@ads.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'super_admin' });
  s.p = await login('owner@ads.test');
  const billing = await access.systemRole('billing');
  await models.User.create({ name: 'Billing', email: 'billing@ads.test', passwordHash: await models.User.hashPassword(PASSWORD), platformRole: 'staff', platformRoleId: billing._id });
  s.billing = await login('billing@ads.test');
  s.adminRole = await access.systemRole('admin');
});
after(teardown);

describe('permissions and validation', () => {
  test('ads.manage is a platform permission held by the Owner and Admin roles', async () => {
    const { ALL_PERMISSIONS, SYSTEM_ROLES } = await import('../src/modules/platformTeam/permissions.js');
    assert.ok(ALL_PERMISSIONS.includes('ads.manage'));
    assert.ok(SYSTEM_ROLES.find((r) => r.key === 'owner').permissions.includes('ads.manage'));
    assert.ok(s.adminRole.permissions.includes('ads.manage'));
    assert.equal((await api.get(`${V}/ads/platform`).set(s.billing)).status, 403);
    assert.equal((await api.get(`${V}/ads/platform`).set(s.A.h)).status, 403, 'society admins have no platform access');
    ok(await api.get(`${V}/ads/platform`).set(s.p));
  });

  test('media: images and MP4/WebM videos only, with size caps', async () => {
    const pdf = await upload(s.p, 'platform', PDF, 'x.pdf');
    assert.equal(pdf.status, 400);
    assert.match(pdf.body.error.message, /MP4 or WebM/);
    const video = await upload(s.p, 'platform', MP4, 'clip.mp4');
    ok(video, 201);
    assert.equal(video.body.data.mimetype, 'video/mp4');
    s.videoId = video.body.data._id;
    const big = await upload(s.p, 'platform', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 10)]), 'big.png');
    assert.equal(big.status, 400);
    assert.match(big.body.error.message, /5 MB/);
  });

  test('landing URL must be https', async () => {
    const mediaId = await media(s.p, 'platform');
    for (const landingUrl of ['http://example.com', 'javascript:alert(1)', 'ftp://x.test/file', 'https://user:pw@example.com', 'example.com']) {
      const res = await postAd(s.p, 'platform', { title: 'Bad link', mediaId, landingUrl, ...window() });
      assert.equal(res.status, 422, landingUrl);
    }
    const end = await postAd(s.p, 'platform', { title: 'Bad dates', mediaId, landingUrl: 'https://example.com', startAt: new Date().toISOString(), endAt: new Date(Date.now() - DAY).toISOString() });
    assert.equal(end.status, 422);
  });
});

describe('targeting', () => {
  test('platform banner for all societies reaches every role in every society', async () => {
    const res = await postAd(s.p, 'platform', { title: 'Home loans at 8.1%', mediaId: await media(s.p, 'platform'), landingUrl: 'https://bank.example.com/loans', placement: 'banner', ...window() });
    ok(res, 201);
    s.allAd = res.body.data._id;
    assert.ok((await bannerTitles(s.resA)).includes('Home loans at 8.1%'));
    assert.ok((await bannerTitles(s.resB)).includes('Home loans at 8.1%'));
    assert.ok((await bannerTitles(s.guardA)).includes('Home loans at 8.1%'));
    assert.ok(!(await bannerTitles(s.p)).includes('Home loans at 8.1%'), 'not in the platform console unless asked');
  });

  test('selected societies and roles only', async () => {
    const mediaId = await media(s.p, 'platform');
    ok(await postAd(s.p, 'platform', { title: 'Alpha only', mediaId, landingUrl: 'https://a.example.com', audience: { allSocieties: false, societies: [s.A.id] }, ...window() }), 201);
    ok(await postAd(s.p, 'platform', { title: 'Guards only', mediaId: await media(s.p, 'platform'), landingUrl: 'https://g.example.com', audience: { roles: ['guard'] }, ...window() }), 201);
    ok(await postAd(s.p, 'platform', { title: 'Console too', mediaId: await media(s.p, 'platform'), landingUrl: 'https://c.example.com', audience: { allSocieties: false, platform: true }, ...window() }), 201);
    const none = await postAd(s.p, 'platform', { title: 'Nobody', mediaId: await media(s.p, 'platform'), landingUrl: 'https://n.example.com', audience: { allSocieties: false }, ...window() });
    assert.equal(none.status, 400);

    assert.ok((await bannerTitles(s.resA)).includes('Alpha only'));
    assert.ok(!(await bannerTitles(s.resB)).includes('Alpha only'));
    assert.ok((await bannerTitles(s.guardA)).includes('Guards only'));
    assert.ok(!(await bannerTitles(s.resA)).includes('Guards only'));
    assert.deepEqual(await bannerTitles(s.p), ['Console too']);
  });

  test('schedule window and the active switch', async () => {
    ok(await postAd(s.p, 'platform', { title: 'Next week', mediaId: await media(s.p, 'platform'), landingUrl: 'https://f.example.com', ...window(5, 9) }), 201);
    ok(await postAd(s.p, 'platform', { title: 'Last week', mediaId: await media(s.p, 'platform'), landingUrl: 'https://f.example.com', ...window(-9, -2) }), 201);
    const paused = await postAd(s.p, 'platform', { title: 'Paused', active: false, mediaId: await media(s.p, 'platform'), landingUrl: 'https://f.example.com', ...window() });
    ok(paused, 201);
    const titles = await bannerTitles(s.resB);
    for (const t of ['Next week', 'Last week', 'Paused']) assert.ok(!titles.includes(t), t);
    const list = await api.get(`${V}/ads/platform`).set(s.p).query({ status: 'scheduled' });
    ok(list);
    assert.deepEqual(list.body.data.map((a) => a.title), ['Next week']);
  });
});

describe('pop-ups', () => {
  test('at most one pop-up, highest priority first, and frequency is respected', async () => {
    const mk = async (title, frequency, priority) => {
      const res = await postAd(s.p, 'platform', { title, frequency, priority, placement: 'popup', mediaId: s.videoId, landingUrl: 'https://p.example.com', audience: { allSocieties: false, societies: [s.B.id] }, ...window() });
      ok(res, 201);
      assert.equal(res.body.data.mediaType, 'video');
      return res.body.data._id;
    };
    const once = await mk('Once popup', 'once', 30);
    const daily = await mk('Daily popup', 'daily', 20);
    await mk('Every visit popup', 'every_visit', 10);
    const seen = (id) => api.post(`${V}/ads/${id}/impression`).set(s.resB).send({ placement: 'popup' });

    assert.equal((await active(s.resB)).popup.title, 'Once popup');
    ok(await seen(once));
    assert.equal((await active(s.resB)).popup.title, 'Daily popup', 'once: never again');
    ok(await seen(daily));
    assert.equal((await active(s.resB)).popup.title, 'Every visit popup', 'daily: not again today');
    ok(await seen((await active(s.resB)).popup._id));
    assert.equal((await active(s.resB)).popup.title, 'Every visit popup', 'every visit: always due');

    // A day later the daily one is due again (and still ahead of "every visit" by priority); "once" stays gone.
    const user = await models.User.findOne({ email: 'res@beta.test' }).lean();
    await models.AdSeen.updateMany({ user: user._id }, { $set: { lastSeenAt: new Date(Date.now() - 2 * DAY) } });
    assert.equal((await active(s.resB)).popup.title, 'Daily popup');
    // Popups never show as banners.
    assert.ok(!(await bannerTitles(s.resB)).some((t) => t.endsWith('popup')));
  });
});

describe('society ads', () => {
  test('admin and facility manager run ads for their own society only', async () => {
    const mediaId = await media(s.A.h, 'society');
    const res = await postAd(s.A.h, 'society', { title: 'Diwali mela at the clubhouse', mediaId, landingUrl: 'https://alpha.example.com/mela', placement: 'both', audience: { allSocieties: true, societies: [s.B.id], platform: true }, ...window() });
    ok(res, 201);
    s.societyAd = res.body.data._id;
    assert.equal(res.body.data.society, s.A.id);
    assert.deepEqual(res.body.data.audience.societies, [], 'society ads cannot target other societies');
    assert.equal(res.body.data.audience.platform, false);
    ok(await postAd(s.fmA, 'society', { title: 'Yoga class', mediaId: await media(s.fmA, 'society'), landingUrl: 'https://alpha.example.com/yoga', ...window() }), 201);
    assert.equal((await postAd(s.resA, 'society', { title: 'x', mediaId, landingUrl: 'https://x.test', ...window() })).status, 403);
    assert.equal((await api.get(`${V}/ads/society`).set(s.accA)).status, 403, 'accountants do not manage ads');

    assert.ok((await bannerTitles(s.resA)).includes('Diwali mela at the clubhouse'));
    assert.ok(!(await bannerTitles(s.resB)).includes('Diwali mela at the clubhouse'));
    assert.ok(!(await bannerTitles(s.p)).includes('Diwali mela at the clubhouse'));
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await models.AuditLog.exists({ society: s.A.id, action: 'ad.created' }));
  });

  test('cross-society isolation: other societies cannot see, edit, count or reuse media', async () => {
    assert.equal((await api.patch(`${V}/ads/society/${s.societyAd}`).set(s.B.h).send({ title: 'Mine now' })).status, 404);
    assert.equal((await api.delete(`${V}/ads/society/${s.societyAd}`).set(s.B.h)).status, 404);
    assert.equal((await api.get(`${V}/ads/society/${s.societyAd}/stats`).set(s.B.h)).status, 404);
    assert.equal((await api.post(`${V}/ads/${s.societyAd}/click`).set(s.resB)).status, 404);
    const listB = await api.get(`${V}/ads/society`).set(s.B.h);
    ok(listB);
    assert.equal(listB.body.data.length, 0);
    const foreignMedia = await media(s.A.h, 'society');
    const res = await postAd(s.B.h, 'society', { title: 'Stolen', mediaId: foreignMedia, landingUrl: 'https://b.example.com', ...window() });
    assert.equal(res.status, 400);
    // Platform media can't be used for society ads either.
    assert.equal((await postAd(s.A.h, 'society', { title: 'Platform clip', mediaId: s.videoId, landingUrl: 'https://b.example.com', ...window() })).status, 400);
    ok(await api.patch(`${V}/ads/society/${s.societyAd}`).set(s.fmA).send({ priority: 50 }));
  });

  test('platform can switch society ads off per society', async () => {
    const off = await api.put(`${V}/ads/platform/societies/${s.A.id}/settings`).set(s.p).send({ allowSocietyAds: false });
    ok(off);
    assert.ok(!(await bannerTitles(s.resA)).includes('Diwali mela at the clubhouse'));
    assert.ok((await bannerTitles(s.resA)).includes('Home loans at 8.1%'), 'platform ads unaffected');
    const blocked = await postAd(s.A.h, 'society', { title: 'Blocked', mediaId: await media(s.A.h, 'society'), landingUrl: 'https://a.example.com', ...window() });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'SOCIETY_ADS_DISABLED');
    assert.equal((await api.get(`${V}/ads/society/settings`).set(s.A.h)).body.data.allowSocietyAds, false);
    const list = await api.get(`${V}/ads/platform/societies`).set(s.p).query({ search: 'Alpha' });
    ok(list);
    assert.equal(list.body.data[0].allowSocietyAds, false);
    assert.equal(list.body.data[0].societyAds, 2);
    assert.equal((await api.put(`${V}/ads/platform/societies/${s.A.id}/settings`).set(s.A.h).send({ allowSocietyAds: true })).status, 403);
    ok(await api.put(`${V}/ads/platform/societies/${s.A.id}/settings`).set(s.p).send({ allowSocietyAds: true }));
    assert.ok((await bannerTitles(s.resA)).includes('Diwali mela at the clubhouse'));
  });
});

describe('counters', () => {
  test('impressions, clicks and dismissals are counted per ad per day, with CTR', async () => {
    for (let i = 0; i < 4; i += 1) ok(await api.post(`${V}/ads/${s.societyAd}/impression`).set(s.resA).send({ placement: 'banner' }));
    ok(await api.post(`${V}/ads/${s.societyAd}/click`).set(s.resA).send({ placement: 'banner' }));
    ok(await api.post(`${V}/ads/${s.societyAd}/dismiss`).set(s.guardA).send({ placement: 'banner' }));
    const stats = await api.get(`${V}/ads/society/${s.societyAd}/stats`).set(s.A.h);
    ok(stats);
    assert.deepEqual(stats.body.data.totals, { impressions: 4, clicks: 1, dismissals: 1, ctr: 25 });
    assert.equal(stats.body.data.days.length, 1);
    const list = await api.get(`${V}/ads/society`).set(s.A.h);
    assert.equal(list.body.data.find((a) => a._id === s.societyAd).stats.clicks, 1);
    // The platform sees society ads' numbers too.
    ok(await api.get(`${V}/ads/platform/${s.societyAd}/stats`).set(s.p));
  });

  test('a dismissed banner is hidden for that person for the rest of the day', async () => {
    assert.ok(!(await bannerTitles(s.guardA)).includes('Diwali mela at the clubhouse'));
    assert.ok((await bannerTitles(s.resA)).includes('Diwali mela at the clubhouse'));
  });

  test('deleting an ad removes its numbers', async () => {
    ok(await api.delete(`${V}/ads/society/${s.societyAd}`).set(s.A.h));
    assert.equal((await api.get(`${V}/ads/society/${s.societyAd}/stats`).set(s.A.h)).status, 404);
    assert.ok(!(await bannerTitles(s.resA)).includes('Diwali mela at the clubhouse'));
  });
});
