import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, setup, teardown } from './helpers.js';

let api;
let totp;
let seal;
let models;
const s = {};
const PW = 'Password@123';
const V = '/api/v1';

const login = async (identifier, password = PW) => {
  const res = await api.post(`${V}/auth/login`).send({ identifier, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const h = (who) => bearer(s[who].accessToken);
const userId = (who) => s[who].user._id;

// Each accepted code burns its time step. Tests that log in repeatedly rewind the "last used" marker so the
// current code is fresh again (in real life the user just waits for the next code).
async function freshCode(who, offsetMs = 0) {
  const step = totp.stepAt(Date.now());
  await models.User.updateOne({ _id: userId(who) }, { $set: { 'mfa.lastUsedStep': step - 3 } });
  return totp.totp(s[`${who}Secret`], Date.now() + offsetMs);
}

// Enables two-step verification for a signed-in user; keeps the secret for generating codes.
async function enableMfa(who) {
  const setupRes = await api.post(`${V}/auth/mfa/setup`).set(h(who));
  assert.equal(setupRes.status, 200, JSON.stringify(setupRes.body));
  s[`${who}Secret`] = setupRes.body.data.secret;
  const res = await api.post(`${V}/auth/mfa/enable`).set(h(who)).send({ code: totp.totp(setupRes.body.data.secret) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.backupCodes;
}

const SECRET_KEYS = ['passwordHash', 'tokenHash', 'pendingSecret', 'backupCodes', 'lastUsedStep', 'codeHash'];
function assertNoSecrets(body, extra = []) {
  const text = JSON.stringify(body);
  for (const k of SECRET_KEYS) assert.ok(!text.includes(`"${k}"`), `response leaks ${k}`);
  assert.ok(!/"mfa"\s*:/.test(text), 'response leaks the mfa subdocument');
  for (const value of extra) assert.ok(!text.includes(value), `response leaks ${value}`);
}

before(async () => {
  api = await setup();
  totp = await import('../src/common/utils/totp.js');
  seal = await import('../src/common/utils/secretBox.js');
  models = {
    User: (await import('../src/modules/users/user.model.js')).default,
    Membership: (await import('../src/modules/users/membership.model.js')).default,
    Bill: (await import('../src/modules/billing/bill.model.js')).default,
    Payment: (await import('../src/modules/payments/payment.model.js')).default,
    AuditLog: (await import('../src/modules/audit/audit.model.js')).default,
    RefreshToken: (await import('../src/modules/auth/refreshToken.model.js')).default,
  };

  const reg = await api.post(`${V}/auth/register-society`).send({ society: { name: 'Lotus Residency' }, admin: { name: 'Asha Admin', email: 'admin@lotus.test', phone: '9700000001', password: PW } });
  s.admin = reg.body.data;
  s.societyA = s.admin.user.society._id;
  const block = await api.post(`${V}/blocks`).set(h('admin')).send({ name: 'A' });
  await api.post(`${V}/units/bulk`).set(h('admin')).send({ block: block.body.data._id, fromFloor: 1, toFloor: 1, unitsPerFloor: 2, areaSqft: 900 });
  const units = (await api.get(`${V}/units`).set(h('admin'))).body.data;
  s.u101 = units.find((u) => u.label === 'A-101')._id;
  s.u102 = units.find((u) => u.label === 'A-102')._id;
  const people = [
    ['acc', 'accountant', '9700000002'],
    ['r1', 'resident', '9700000003', s.u101],
    ['r2', 'resident', '9700000004', s.u102],
  ];
  for (const [key, role, phone, unit] of people) {
    const body = { name: `${key} person`, email: `${key}@lotus.test`, phone, password: PW, role, ...(unit ? { unit, residentType: 'owner' } : {}) };
    // eslint-disable-next-line no-await-in-loop
    const res = await api.post(`${V}/users`).set(h('admin')).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // eslint-disable-next-line no-await-in-loop
    s[key] = await login(`${key}@lotus.test`);
  }

  const other = await api.post(`${V}/auth/register-society`).send({ society: { name: 'Banyan Towers' }, admin: { name: 'Bala Admin', email: 'admin@banyan.test', password: PW } });
  s.otherAdmin = other.body.data;

  // Platform owners have no society.
  for (const key of ['sa', 'sa2']) {
    // eslint-disable-next-line no-await-in-loop
    await models.User.create({ name: `${key} owner`, email: `${key}@platform.test`, passwordHash: await models.User.hashPassword(PW), platformRole: 'super_admin' });
    // eslint-disable-next-line no-await-in-loop
    s[key] = await login(`${key}@platform.test`);
  }
});
after(teardown);

describe('TOTP primitives', () => {
  test('RFC 6238 SHA-1 test vectors', () => {
    const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const vectors = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, expected] of vectors) assert.equal(totp.totp(secret, t * 1000, { digits: 8 }), expected, `T=${t}`);
    // 6-digit form is the low 6 digits
    assert.equal(totp.totp(secret, 59 * 1000), '287082');
  });

  test('base32 round trip, ±1 step window, malformed codes', () => {
    const secret = totp.generateSecret();
    assert.equal(secret.length, 32);
    assert.deepEqual(totp.base32Decode(totp.base32Encode(Buffer.from('hello world'))), Buffer.from('hello world'));
    const now = 1_700_000_000_000;
    const step = totp.stepAt(now);
    assert.equal(totp.verifyTotp(secret, totp.totp(secret, now), { timeMs: now }), step);
    assert.equal(totp.verifyTotp(secret, totp.totp(secret, now - 30_000), { timeMs: now }), step - 1);
    assert.equal(totp.verifyTotp(secret, totp.totp(secret, now + 30_000), { timeMs: now }), step + 1);
    assert.equal(totp.verifyTotp(secret, totp.totp(secret, now - 90_000), { timeMs: now }), null);
    assert.equal(totp.verifyTotp(secret, 'abcdef', { timeMs: now }), null);
    assert.equal(totp.verifyTotp(secret, '', { timeMs: now }), null);
    assert.match(totp.otpauthUri({ secret, account: 'a@b.test', issuer: 'ColonyHub' }), /^otpauth:\/\/totp\/ColonyHub%3Aa%40b\.test\?secret=[A-Z2-7]+&issuer=ColonyHub/);
  });

  test('sealed secrets round trip and detect tampering', () => {
    const sealed = seal.seal('JBSWY3DPEHPK3PXP', 'mfa-totp-secret');
    assert.ok(!sealed.includes('JBSWY3DPEHPK3PXP'));
    assert.equal(seal.open(sealed, 'mfa-totp-secret'), 'JBSWY3DPEHPK3PXP');
    assert.throws(() => seal.open(sealed, 'other-purpose'));
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => seal.open(parts.join('.'), 'mfa-totp-secret'));
  });
});

describe('two-step verification', () => {
  test('setup + enable stores only sealed/hashed secrets and returns 10 backup codes once', async () => {
    const setupRes = await api.post(`${V}/auth/mfa/setup`).set(h('r1'));
    assert.equal(setupRes.status, 200);
    const { secret, otpauthUri } = setupRes.body.data;
    assert.match(otpauthUri, /^otpauth:\/\/totp\//);
    assert.ok(otpauthUri.includes(`secret=${secret}`));
    const pending = await models.User.findById(userId('r1')).select('+mfa').lean();
    assert.ok(pending.mfa.pendingSecret.startsWith('v1.'));
    assert.ok(!pending.mfa.pendingSecret.includes(secret));
    assert.ok(!pending.mfa.enabled);

    const wrong = await api.post(`${V}/auth/mfa/enable`).set(h('r1')).send({ code: totp.totp(secret, Date.now() - 300_000) });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'MFA_CODE_INVALID');

    const res = await api.post(`${V}/auth/mfa/enable`).set(h('r1')).send({ code: totp.totp(secret) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.backupCodes.length, 10);
    assert.equal(new Set(res.body.data.backupCodes).size, 10);
    s.r1Secret = secret;
    s.r1Backup = res.body.data.backupCodes;

    const stored = (await models.User.findById(userId('r1')).select('+mfa').lean()).mfa;
    assert.equal(stored.enabled, true);
    assert.ok(stored.secret.startsWith('v1.') && !stored.secret.includes(secret));
    assert.equal(stored.pendingSecret, undefined);
    assert.equal(stored.backupCodes.length, 10);
    for (const c of s.r1Backup) assert.ok(!stored.backupCodes.includes(c) && !stored.backupCodes.includes(c.replace('-', '')));

    const again = await api.post(`${V}/auth/mfa/setup`).set(h('r1'));
    assert.equal(again.status, 409);
    const status = await api.get(`${V}/auth/mfa`).set(h('r1'));
    assert.deepEqual([status.body.data.enabled, status.body.data.backupCodesLeft], [true, 10]);
  });

  test('MFA secrets never appear in API responses', async () => {
    const me = await api.get(`${V}/auth/me`).set(h('r1'));
    assert.equal(me.body.data.mfaEnabled, true);
    assertNoSecrets(me.body, [s.r1Secret, ...s.r1Backup]);
    const members = await api.get(`${V}/users?limit=100`).set(h('admin'));
    assert.equal(members.status, 200);
    assertNoSecrets(members.body, [s.r1Secret]);
    const member = members.body.data.find((m) => m.email === 'r1@lotus.test');
    const one = await api.get(`${V}/users/${member._id}`).set(h('admin'));
    assertNoSecrets(one.body, [s.r1Secret]);
    const status = await api.get(`${V}/auth/mfa`).set(h('r1'));
    assertNoSecrets(status.body, [s.r1Secret, ...s.r1Backup]);
  });

  test('password login asks for the code; the mfaToken is not an access token and is single use', async () => {
    const first = await api.post(`${V}/auth/login`).send({ identifier: 'r1@lotus.test', password: PW });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.mfaRequired, true);
    assert.equal(first.body.data.accessToken, undefined);
    assert.equal(first.body.data.refreshToken, undefined);
    const { mfaToken } = first.body.data;
    assertNoSecrets(first.body);

    assert.equal((await api.get(`${V}/auth/me`).set(bearer(mfaToken))).status, 401);
    // and an access token can't stand in for an mfaToken
    assert.equal((await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: s.r1.accessToken, code: '123456' })).status, 401);

    const bad = await api.post(`${V}/auth/mfa/verify`).send({ mfaToken, code: totp.totp(s.r1Secret, Date.now() - 300_000) });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'MFA_CODE_INVALID');

    const code = await freshCode('r1');
    const ok = await api.post(`${V}/auth/mfa/verify`).send({ mfaToken, code });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.data.accessToken && ok.body.data.refreshToken);
    assert.equal(ok.body.data.user.email, 'r1@lotus.test');
    assertNoSecrets(ok.body, [s.r1Secret]);
    s.r1 = ok.body.data;

    const reuseToken = await api.post(`${V}/auth/mfa/verify`).send({ mfaToken, code: totp.totp(s.r1Secret, Date.now() + 30_000) });
    assert.equal(reuseToken.status, 401);
    assert.equal(reuseToken.body.error.code, 'MFA_TOKEN_INVALID');

    // The same code can't be replayed on a fresh login inside its 30 s window.
    const second = await api.post(`${V}/auth/login`).send({ identifier: 'r1@lotus.test', password: PW });
    const replay = await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: second.body.data.mfaToken, code });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'MFA_CODE_REUSED');
  });

  test('a code from the previous 30 s step is accepted (clock drift); two steps back is not', async () => {
    const prev = await freshCode('r1', -30_000);
    const t1 = (await api.post(`${V}/auth/login`).send({ identifier: 'r1@lotus.test', password: PW })).body.data.mfaToken;
    assert.equal((await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: t1, code: prev })).status, 200);
    const old = await freshCode('r1', -90_000);
    const t2 = (await api.post(`${V}/auth/login`).send({ identifier: 'r1@lotus.test', password: PW })).body.data.mfaToken;
    assert.equal((await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: t2, code: old })).status, 401);
  });

  test('backup codes work once', async () => {
    const t1 = (await api.post(`${V}/auth/login`).send({ identifier: 'r1@lotus.test', password: PW })).body.data.mfaToken;
    const used = await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: t1, backupCode: s.r1Backup[0].toLowerCase() });
    assert.equal(used.status, 200, JSON.stringify(used.body));
    const t2 = (await api.post(`${V}/auth/login`).send({ identifier: 'r1@lotus.test', password: PW })).body.data.mfaToken;
    const again = await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: t2, backupCode: s.r1Backup[0] });
    assert.equal(again.status, 401);
    assert.equal((await api.get(`${V}/auth/mfa`).set(h('r1'))).body.data.backupCodesLeft, 9);
    const neither = await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: t2 });
    assert.equal(neither.status, 422);
  });

  test('five wrong codes lock the mfaToken', async () => {
    const t = (await api.post(`${V}/auth/login`).send({ identifier: 'r1@lotus.test', password: PW })).body.data.mfaToken;
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      statuses.push((await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: t, code: '000000' })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
    const right = await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: t, code: await freshCode('r1') });
    assert.equal(right.status, 429);
    assert.equal(right.body.error.code, 'MFA_LOCKED');
    // a new login gets a new token
    const t2 = (await api.post(`${V}/auth/login`).send({ identifier: 'r1@lotus.test', password: PW })).body.data.mfaToken;
    assert.equal((await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: t2, code: await freshCode('r1') })).status, 200);
  });

  test('SMS-code login also requires the second step', async () => {
    const reqOtp = await api.post(`${V}/auth/otp/request`).send({ phone: '9700000003' });
    assert.ok(reqOtp.body.data.devCode, JSON.stringify(reqOtp.body));
    const res = await api.post(`${V}/auth/otp/verify`).send({ phone: '9700000003', code: reqOtp.body.data.devCode });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.mfaRequired, true);
    assert.equal(res.body.data.accessToken, undefined);
    const done = await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: res.body.data.mfaToken, code: await freshCode('r1') });
    assert.equal(done.status, 200);
  });

  test('a password reset does not bypass two-step verification', async () => {
    const forgot = await api.post(`${V}/auth/password/forgot`).send({ email: 'r1@lotus.test' });
    const token = new URL(forgot.body.data.devLink).searchParams.get('token');
    const reset = await api.post(`${V}/auth/password/reset`).send({ token, password: 'NewPass@456' });
    assert.equal(reset.status, 200);
    const res = await api.post(`${V}/auth/login`).send({ identifier: 'r1@lotus.test', password: 'NewPass@456' });
    assert.equal(res.body.data.mfaRequired, true);
    const done = await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: res.body.data.mfaToken, code: await freshCode('r1') });
    assert.equal(done.status, 200);
    s.r1 = done.body.data;
  });

  test('regenerating backup codes needs a current code and invalidates the old ones', async () => {
    assert.equal((await api.post(`${V}/auth/mfa/backup-codes`).set(h('r1')).send({ code: '000000' })).status, 400);
    const res = await api.post(`${V}/auth/mfa/backup-codes`).set(h('r1')).send({ code: await freshCode('r1') });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.backupCodes.length, 10);
    const t = (await api.post(`${V}/auth/login`).send({ identifier: 'r1@lotus.test', password: 'NewPass@456' })).body.data.mfaToken;
    assert.equal((await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: t, backupCode: s.r1Backup[1] })).status, 401);
    assert.equal((await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: t, backupCode: res.body.data.backupCodes[0] })).status, 200);
  });

  test('disable needs the password and a code; afterwards login is one step again', async () => {
    assert.equal((await api.post(`${V}/auth/mfa/disable`).set(h('r1')).send({ password: 'wrong-password', code: await freshCode('r1') })).status, 400);
    assert.equal((await api.post(`${V}/auth/mfa/disable`).set(h('r1')).send({ password: 'NewPass@456', code: '000000' })).status, 400);
    const res = await api.post(`${V}/auth/mfa/disable`).set(h('r1')).send({ password: 'NewPass@456', code: await freshCode('r1') });
    assert.equal(res.status, 200);
    const stored = await models.User.findById(userId('r1')).select('+mfa').lean();
    assert.equal(stored.mfa, undefined);
    const direct = await login('r1@lotus.test', 'NewPass@456');
    assert.ok(direct.accessToken);
    assert.equal(direct.user.mfaEnabled, false);
    s.r1 = direct;
  });

  test('society policy flags admins and accountants who have not set it up', async () => {
    assert.equal((await api.patch(`${V}/society/me/settings`).set(h('acc')).send({ security: { requireMfa: true } })).status, 403);
    const early = await api.patch(`${V}/society/me/settings`).set(h('admin')).send({ security: { requireMfa: true } });
    assert.equal(early.status, 409, 'an admin without two-step cannot lock themselves out');
    await enableMfa('admin');
    const set = await api.patch(`${V}/society/me/settings`).set(h('admin')).send({ security: { requireMfa: true } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.data.settings.security.requireMfa, true);
    // sibling settings untouched
    assert.equal(set.body.data.settings.visitorApprovalRequired, true);

    const acc = await login('acc@lotus.test');
    assert.equal(acc.user.mfaSetupRequired, true);
    assert.equal(acc.user.mfaEnabled, false);
    s.acc = acc;
    const r2 = await login('r2@lotus.test');
    assert.equal(r2.user.mfaSetupRequired, false);
    // only the session/setup endpoints work until it is on; the API refuses the rest
    assert.equal((await api.get(`${V}/auth/me`).set(h('acc'))).body.data.mfaSetupRequired, true);
    const blocked = await api.get(`${V}/society/me`).set(h('acc'));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'MFA_SETUP_REQUIRED');

    await enableMfa('acc');
    assert.equal((await api.get(`${V}/auth/me`).set(h('acc'))).body.data.mfaSetupRequired, false);
    assert.equal((await api.get(`${V}/society/me`).set(h('acc'))).status, 200, 'unblocked once it is on');
    const next = await api.post(`${V}/auth/login`).send({ identifier: 'acc@lotus.test', password: PW });
    assert.equal(next.body.data.mfaRequired, true);

    // Other societies are unaffected.
    const other = await login('admin@banyan.test');
    assert.equal(other.user.mfaSetupRequired, false);
  });

  test('platform owners can enable it, and support sessions still open', async () => {
    await enableMfa('sa');
    const step1 = await api.post(`${V}/auth/login`).send({ identifier: 'sa@platform.test', password: PW });
    assert.equal(step1.body.data.mfaRequired, true);
    const done = await api.post(`${V}/auth/mfa/verify`).send({ mfaToken: step1.body.data.mfaToken, code: await freshCode('sa') });
    assert.equal(done.status, 200);
    s.sa = done.body.data;
    const support = await api.post(`${V}/auth/support-session`).set(h('sa')).send({ societyId: s.societyA, reason: 'MFA test' });
    assert.equal(support.status, 200, JSON.stringify(support.body));
    assert.equal(support.body.data.user.role, 'admin');
    assert.equal(support.body.data.user.mfaSetupRequired, false);
    assert.equal((await api.get(`${V}/society/me`).set(bearer(support.body.data.accessToken))).status, 200);
    s.saSupportA = support.body.data;
    const back = await api.post(`${V}/auth/switch`).set(h('sa')).send({ membershipId: null });
    assert.equal(back.status, 200);
  });
});

describe('personal data export', () => {
  before(async () => {
    const complaint = await api.post(`${V}/complaints`).set(h('r1')).send({ category: 'plumbing', title: 'Kitchen tap leaking', description: 'Drips all night' });
    assert.equal(complaint.status, 201, JSON.stringify(complaint.body));
    s.complaint = complaint.body.data._id;
    await api.post(`${V}/complaints/${s.complaint}/comments`).set(h('admin')).send({ text: 'STAFF-ONLY-NOTE', internal: true });
    await api.post(`${V}/complaints/${s.complaint}/comments`).set(h('r1')).send({ text: 'Still leaking' });

    const poll = await api.post(`${V}/polls`).set(h('admin')).send({ question: 'Paint the lobby blue?', options: ['Yes', 'No'], audience: { type: 'all' } });
    assert.equal(poll.status, 201, JSON.stringify(poll.body));
    assert.equal((await api.post(`${V}/polls/${poll.body.data._id}/vote`).set(h('r1')).send({ optionIndex: 1 })).status, 200);
    await api.post(`${V}/polls/${poll.body.data._id}/vote`).set(h('r2')).send({ optionIndex: 0 });

    const mkBill = (unit, period, n) =>
      models.Bill.create({ society: s.societyA, unit, period, billNumber: `BILL-${n}`, lines: [{ head: 'Maintenance', amount: 250000 }], amount: 250000, total: 250000, dueDate: new Date() });
    s.bill = await mkBill(s.u101, '2026-09', 'A101-09');
    await mkBill(s.u102, '2026-09', 'A102-09');
    s.payment = await models.Payment.create({ society: s.societyA, bill: s.bill._id, unit: s.u101, amount: 250000, method: 'upi', receiptNumber: 'RCPT-9001', paidAt: new Date(), paidBy: userId('r1') });
  });

  test('downloads the person’s own data as an attachment, without secrets or other people’s data', async () => {
    const res = await api.get(`${V}/me/data-export`).set(h('r1'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.headers['content-disposition'], /^attachment; filename="colonyhub-my-data-\d{4}-\d{2}-\d{2}\.json"$/);
    assert.match(res.headers['content-type'], /application\/json/);
    const data = res.body;
    assert.equal(data.profile.email, 'r1@lotus.test');
    assert.equal(data.memberships[0].society, 'Lotus Residency');
    assert.equal(data.memberships[0].unit, 'A-101');
    assert.equal(data.complaints.length, 1);
    assert.equal(data.complaints[0].title, 'Kitchen tap leaking');
    assert.deepEqual(data.complaints[0].comments.map((c) => c.text), ['Still leaking']);
    assert.deepEqual(data.pollVotes.map((v) => [v.question, v.yourChoice]), [['Paint the lobby blue?', 'No']]);
    assert.ok(!JSON.stringify(data.pollVotes).includes('votes'));
    assert.deepEqual(data.bills.map((b) => b.billNumber), ['BILL-A101-09']);
    assert.equal(data.payments[0].receiptNumber, 'RCPT-9001');
    assert.equal(data.payments[0].paidByYou, true);
    assert.ok(data.signedInDevices.length >= 1);
    assert.ok(data.consents.notificationChannels);
    const text = JSON.stringify(data);
    assertNoSecrets(data);
    for (const leak of ['STAFF-ONLY-NOTE', 'BILL-A102-09', 'r2@lotus.test', '9700000004', s.r1.refreshToken, 'refreshToken']) assert.ok(!text.includes(leak), `export leaks ${leak}`);
  });

  test('is limited to one download per 10 minutes', async () => {
    const res = await api.get(`${V}/me/data-export`).set(h('r1'));
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'EXPORT_COOLDOWN');
    // per person, not global
    assert.equal((await api.get(`${V}/me/data-export`).set(h('r2'))).status, 200);
  });

  test('platform owners (no society) can export too', async () => {
    const res = await api.get(`${V}/me/data-export`).set(h('sa'));
    assert.equal(res.status, 200);
    assert.equal(res.body.profile.platformRole, 'super_admin');
    assert.deepEqual(res.body.memberships, []);
    assertNoSecrets(res.body, [s.saSecret]);
  });
});

describe('account deletion requests', () => {
  test('a member files a request; only their society’s admin sees it', async () => {
    const res = await api.post(`${V}/me/deletion-request`).set(h('r1')).send({ reason: 'Moving out' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'pending');
    assert.deepEqual(res.body.data.soleAdminOf, []);
    s.req1 = res.body.data._id;
    assert.equal((await api.post(`${V}/me/deletion-request`).set(h('r1')).send({})).status, 409);
    assert.equal((await api.get(`${V}/me/deletion-request`).set(h('r1'))).body.data.status, 'pending');

    assert.equal((await api.get(`${V}/privacy/deletion-requests`).set(h('r2'))).status, 403);
    assert.equal((await api.get(`${V}/privacy/deletion-requests`).set(h('acc'))).status, 403);
    const list = await api.get(`${V}/privacy/deletion-requests?status=pending`).set(h('admin'));
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((r) => r.userName), ['r1 person']);
    assert.equal(list.body.data[0].roles[0].unit, 'A-101');

    // Cross-society isolation
    const otherList = await api.get(`${V}/privacy/deletion-requests`).set(h('otherAdmin'));
    assert.deepEqual(otherList.body.data, []);
    assert.equal((await api.post(`${V}/privacy/deletion-requests/${s.req1}/approve`).set(h('otherAdmin')).send({})).status, 404);
    assert.equal((await api.post(`${V}/privacy/deletion-requests/${s.req1}/reject`).set(h('otherAdmin')).send({ note: 'nope' })).status, 404);
    // platform owners only see people with no society
    assert.deepEqual((await api.get(`${V}/privacy/deletion-requests`).set(h('sa'))).body.data, []);
  });

  test('a rejection needs a reason and tells the member; they can ask again', async () => {
    assert.equal((await api.post(`${V}/privacy/deletion-requests/${s.req1}/reject`).set(h('admin')).send({})).status, 422);
    const rej = await api.post(`${V}/privacy/deletion-requests/${s.req1}/reject`).set(h('admin')).send({ note: 'Dues pending, please clear first' });
    assert.equal(rej.status, 200);
    assert.equal(rej.body.data.status, 'rejected');
    assert.equal((await api.post(`${V}/privacy/deletion-requests/${s.req1}/approve`).set(h('admin')).send({})).status, 400);
    const again = await api.post(`${V}/me/deletion-request`).set(h('r1')).send({ reason: 'Dues cleared' });
    assert.equal(again.status, 201);
    s.req1 = again.body.data._id;
  });

  test('approval anonymises the person but keeps bills, payments and the audit trail', async () => {
    const r1Id = userId('r1');
    const res = await api.post(`${V}/privacy/deletion-requests/${s.req1}/approve`).set(h('admin')).send({ note: 'Verified with office' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'approved');
    assert.ok(res.body.data.completedAt);

    const u = await models.User.findById(r1Id).select('+passwordHash +mfa').lean();
    assert.equal(u.name, 'Former resident');
    assert.equal(u.email, undefined);
    assert.equal(u.phone, undefined);
    assert.equal(u.status, 'inactive');
    assert.ok(u.anonymisedAt);
    const ms = await models.Membership.find({ user: r1Id }).lean();
    assert.ok(ms.every((m) => m.status === 'inactive'));
    assert.equal(await models.RefreshToken.countDocuments({ user: r1Id }), 0);

    // can't log in or refresh any more
    assert.equal((await api.post(`${V}/auth/login`).send({ identifier: 'r1@lotus.test', password: 'NewPass@456' })).status, 401);
    assert.equal((await api.post(`${V}/auth/login`).send({ identifier: '9700000003', password: 'NewPass@456' })).status, 401);
    assert.equal((await api.post(`${V}/auth/refresh`).send({ refreshToken: s.r1.refreshToken })).status, 401);
    assert.equal((await api.get(`${V}/auth/me`).set(h('r1'))).status, 401);

    // statutory / financial records stay with the flat
    const bill = await models.Bill.findById(s.bill._id).lean();
    assert.equal(String(bill.unit), String(s.u101));
    const pay = await models.Payment.findById(s.payment._id).lean();
    assert.equal(pay.receiptNumber, 'RCPT-9001');
    assert.equal(String(pay.paidBy), String(r1Id));

    // the members list no longer shows the person as active, and no PII remains
    const members = await api.get(`${V}/users?limit=100`).set(h('admin'));
    const text = JSON.stringify(members.body);
    assert.ok(!text.includes('r1@lotus.test') && !text.includes('9700000003') && !text.includes('r1 person'));

    // the email/phone are free for a new account
    const reuse = await api.post(`${V}/users`).set(h('admin')).send({ name: 'New owner', email: 'r1@lotus.test', phone: '9700000003', password: PW, role: 'resident', unit: s.u101, residentType: 'owner' });
    assert.equal(reuse.status, 201, JSON.stringify(reuse.body));
    assert.notEqual(String(reuse.body.data.user), String(r1Id));

    await new Promise((r) => setTimeout(r, 100)); // audit writes are fire-and-forget
    const actions = (await models.AuditLog.find({ society: s.societyA, action: /^privacy\./ }).lean()).map((a) => a.action);
    for (const a of ['privacy.data_exported', 'privacy.deletion_requested', 'privacy.deletion_rejected', 'privacy.deletion_approved', 'privacy.user_anonymised']) {
      assert.ok(actions.includes(a), `audit missing ${a}`);
    }
  });

  test('the only admin of a society cannot be deleted until another admin exists', async () => {
    const res = await api.post(`${V}/me/deletion-request`).set(h('otherAdmin')).send({});
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.data.soleAdminOf, ['Banyan Towers']);
    const id = res.body.data._id;
    // can't approve your own request
    assert.equal((await api.post(`${V}/privacy/deletion-requests/${id}/approve`).set(h('otherAdmin')).send({})).status, 403);

    // platform support (temporary admin) does not count as another admin
    const support = await api.post(`${V}/auth/support-session`).set(h('sa')).send({ societyId: s.otherAdmin.user.society._id });
    assert.equal(support.status, 200, JSON.stringify(support.body));
    const sup = bearer(support.body.data.accessToken);
    const blocked = await api.post(`${V}/privacy/deletion-requests/${id}/approve`).set(sup).send({});
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, /Banyan Towers/);

    const second = await api.post(`${V}/users`).set(h('otherAdmin')).send({ name: 'Second admin', email: 'admin2@banyan.test', password: PW, role: 'admin' });
    assert.equal(second.status, 201);
    const okRes = await api.post(`${V}/privacy/deletion-requests/${id}/approve`).set(sup).send({});
    assert.equal(okRes.status, 200, JSON.stringify(okRes.body));
    assert.equal(okRes.body.data.status, 'approved');
    assert.equal((await api.post(`${V}/auth/login`).send({ identifier: 'admin@banyan.test', password: PW })).status, 401);
  });

  test('people with no society are handled by the platform owner', async () => {
    const res = await api.post(`${V}/me/deletion-request`).set(h('sa2')).send({ reason: 'Leaving' });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.societies, 0);
    assert.deepEqual((await api.get(`${V}/privacy/deletion-requests`).set(h('admin'))).body.data.filter((r) => r._id === res.body.data._id), []);
    const list = await api.get(`${V}/privacy/deletion-requests?status=pending`).set(h('sa'));
    assert.deepEqual(list.body.data.map((r) => r._id), [res.body.data._id]);
    const ok = await api.post(`${V}/privacy/deletion-requests/${res.body.data._id}/approve`).set(h('sa')).send({});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const u = await models.User.findOne({ _id: userId('sa2') }).lean();
    assert.equal(u.platformRole, undefined);
    assert.equal(u.name, 'Former resident');
  });

  test('a pending request can be cancelled by the person', async () => {
    assert.equal((await api.post(`${V}/me/deletion-request`).set(h('r2')).send({})).status, 201);
    const c = await api.delete(`${V}/me/deletion-request`).set(h('r2'));
    assert.equal(c.status, 200);
    assert.equal(c.body.data.status, 'cancelled');
    assert.equal((await api.delete(`${V}/me/deletion-request`).set(h('r2'))).status, 404);
  });
});
