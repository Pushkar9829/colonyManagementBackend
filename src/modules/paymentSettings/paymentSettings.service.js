import crypto from 'node:crypto';
import PaymentSettings, { SELECTABLE_MODES } from './paymentSettings.model.js';
import Society from '../society/society.model.js';
import { createProvider, platformRouteProvider, provider as platformProvider } from '../payments/providers.js';
import { open, seal } from '../../common/utils/secretBox.js';
import ApiError from '../../common/errors/ApiError.js';
import * as audit from '../audit/audit.service.js';
import env from '../../config/env.js';
import logger from '../../common/utils/logger.js';

const SEAL_KEY = 'payments.keySecret';
const SEAL_WEBHOOK = 'payments.webhookSecret';
const TEST_AMOUNT = 100; // ₹1
const WITH_SECRETS = '+own.keySecret +own.webhookSecret';

// Societies created before payment settings existed have no document: they keep paying into the platform
// account exactly as before, until their admin sets up their own gateway.
const LEGACY = Object.freeze({ mode: 'platform_legacy', enabled: true, allowedModes: SELECTABLE_MODES, forceDisabled: false, own: {}, route: {} });

const newWebhookKey = () => crypto.randomBytes(12).toString('base64url');
const last4 = (v) => String(v).slice(-4);

const loadRaw = (societyId) => PaymentSettings.findOne({ society: societyId }).select(WITH_SECRETS).lean();
const loadOrLegacy = async (societyId) => (await loadRaw(societyId)) || { ...LEGACY, society: societyId };

// What is still missing before the chosen mode can take money (null = ready).
function setupGap(s) {
  if (s.mode === 'own') {
    if (!s.own?.keyId || !s.own?.keySecretLast4) return 'Enter your Razorpay key id and key secret';
    if (!s.own.connection?.ok) return 'Test the connection to your Razorpay account';
  }
  if (s.mode === 'route') {
    if (!s.route?.linkedAccountId) return 'ColonyHub is setting up your Razorpay linked account';
    if (s.route.status !== 'active') return `Your Razorpay linked account is ${s.route.status || 'pending'}`;
  }
  return null;
}

// off | setup | active | blocked, with the reason shown to the society admin.
export function readiness(s) {
  if (s.forceDisabled) return { status: 'blocked', reason: s.forceDisabledReason || 'Online payments were switched off by ColonyHub' };
  if (s.mode === 'disabled') return { status: 'off', reason: 'Choose how your society receives online payments' };
  if (s.mode !== 'platform_legacy' && !(s.allowedModes || []).includes(s.mode)) return { status: 'blocked', reason: 'ColonyHub has not enabled this payment mode for your society' };
  const gap = setupGap(s);
  if (gap) return { status: s.enabled ? 'setup' : 'off', reason: gap };
  if (!s.enabled) return { status: 'off', reason: 'Online payments are switched off' };
  return { status: 'active', reason: null };
}

function adapterFor(s) {
  if (s.mode === 'own') {
    let keySecret;
    try {
      keySecret = open(s.own.keySecret, SEAL_KEY);
    } catch (err) {
      logger.error({ err: err.message, society: String(s.society) }, 'could not open the society gateway secret');
      throw ApiError.badRequest('The saved Razorpay key secret can no longer be read. Ask the society admin to enter it again.');
    }
    return createProvider({ keyId: s.own.keyId, keySecret });
  }
  if (s.mode === 'route') return platformRouteProvider({ account: s.route.linkedAccountId, commissionPercent: s.route.commissionPercent || 0 });
  return platformProvider; // platform_legacy (and orders made before a society left it)
}

// The ONE place resident-side payment code gets a gateway from. Returns a provider adapter (see
// payments/providers.js) bound to the society's credentials, plus `mode`.
//   purpose 'checkout' (default): new orders, charges and sign-ups. Throws ONLINE_PAYMENTS_OFF unless active.
//   purpose 'settle': verifying, refunding or reading back money already taken. Uses the configured
//   account even while online payments are switched off, so in-flight payments still complete.
export async function getGateway(societyId, { purpose = 'checkout' } = {}) {
  const s = await loadOrLegacy(societyId);
  if (purpose === 'checkout') {
    const r = readiness(s);
    if (r.status !== 'active') throw new ApiError(400, 'ONLINE_PAYMENTS_OFF', String(r.reason).endsWith('.') ? 'Online payments are not available in this society right now. {reason}' : 'Online payments are not available in this society right now. {reason}.', { params: { reason: r.reason } });
  }
  if (s.mode === 'disabled') return { ...platformProvider, mode: 'platform_legacy' };
  return { ...adapterFor(s), mode: s.mode };
}

// For pages that show or hide "Pay online" (any member may ask).
export async function onlineStatus(societyId) {
  const s = await loadOrLegacy(societyId);
  const r = readiness(s);
  return { online: r.status === 'active', mode: s.mode, provider: env.PAYMENT_PROVIDER };
}

// Per-society webhook: the society whose own-gateway webhook key this is, and its webhook secret.
export async function webhookTarget(webhookKey) {
  const s = await PaymentSettings.findOne({ webhookKey }).select(WITH_SECRETS).lean();
  if (!s || s.mode !== 'own' || !s.own?.webhookSecret) return null;
  try {
    return { societyId: s.society, secret: open(s.own.webhookSecret, SEAL_WEBHOOK) };
  } catch {
    return null;
  }
}

// ---------- presentation (secrets never leave the server) ----------
const webhookUrl = (key) => (key ? `${env.PUBLIC_URL.replace(/\/$/, '')}/api/v1/payments/webhook/razorpay/${key}` : null);

function present(s) {
  const r = readiness(s);
  return {
    mode: s.mode,
    legacy: s.mode === 'platform_legacy',
    enabled: Boolean(s.enabled),
    status: r.status,
    statusReason: r.reason,
    allowedModes: s.allowedModes || [],
    forceDisabled: Boolean(s.forceDisabled),
    forceDisabledReason: s.forceDisabled ? s.forceDisabledReason || null : null,
    activatedAt: s.activatedAt || null,
    own: {
      keyId: s.own?.keyId || null,
      keySecretLast4: s.own?.keySecretLast4 || null,
      webhookSecretLast4: s.own?.webhookSecretLast4 || null,
      connection: s.own?.connection || null,
    },
    webhookUrl: webhookUrl(s.webhookKey),
    platformWebhookUrl: webhookUrl(null) || `${env.PUBLIC_URL.replace(/\/$/, '')}/api/v1/payments/webhook/razorpay`,
    route: {
      linkedAccountId: s.route?.linkedAccountId || null,
      status: s.route?.status || 'pending',
      kycStatus: s.route?.kycStatus || null,
      bank: s.route?.bank || {},
      commissionPercent: s.route?.commissionPercent || 0,
      refreshedAt: s.route?.refreshedAt || null,
    },
    testPayment: s.testPayment?.at ? s.testPayment : null,
    provider: env.PAYMENT_PROVIDER, // 'mock' = test mode: no real money moves
  };
}

// ---------- writes ----------
// Creates the document on first write. Existing (legacy) societies keep platform_legacy until they choose.
async function ensureDoc(societyId, insert = { mode: 'platform_legacy', enabled: true }) {
  await PaymentSettings.updateOne({ society: societyId }, { $setOnInsert: { society: societyId, webhookKey: newWebhookKey(), ...insert } }, { upsert: true });
  const s = await loadRaw(societyId);
  if (!s.webhookKey) {
    await PaymentSettings.updateOne({ _id: s._id }, { webhookKey: newWebhookKey() });
    return loadRaw(societyId);
  }
  return s;
}

// New societies start without online payments until their admin sets up a gateway.
export async function initForNewSociety(societyId) {
  await ensureDoc(societyId, { mode: 'disabled', enabled: false });
}

// Stores the computed status and stamps the first activation (and every re-activation).
async function refresh(societyId, actorId) {
  const s = await loadRaw(societyId);
  const r = readiness(s);
  const set = { status: r.status, statusReason: r.reason || undefined };
  if (r.status === 'active' && s.status !== 'active') Object.assign(set, { activatedAt: new Date(), activatedBy: actorId || undefined });
  await PaymentSettings.updateOne({ _id: s._id }, { $set: set });
  return { ...s, ...set };
}

const assertNotBlocked = (s) => {
  if (s.forceDisabled) throw new ApiError(403, 'PAYMENTS_BLOCKED', s.forceDisabledReason || 'Online payments were switched off for your society by ColonyHub');
};

export async function view(ctx) {
  return present(await loadOrLegacy(ctx.societyId));
}

export async function chooseMode(ctx, mode) {
  const s = await ensureDoc(ctx.societyId);
  assertNotBlocked(s);
  if (!s.allowedModes.includes(mode)) throw ApiError.forbidden('ColonyHub has not enabled this payment mode for your society');
  if (s.mode !== mode) {
    // Switching account means checking it again before residents can pay.
    await PaymentSettings.updateOne({ _id: s._id }, { mode, enabled: false });
    audit.record(ctx, 'payments.mode_changed', 'PaymentSettings', s._id, { from: s.mode, to: mode });
  }
  return present(await refresh(ctx.societyId, ctx.userId));
}

export async function saveOwnKeys(ctx, { keyId, keySecret, webhookSecret }) {
  const s = await ensureDoc(ctx.societyId);
  assertNotBlocked(s);
  if (!s.allowedModes.includes('own')) throw ApiError.forbidden('ColonyHub has not enabled your own gateway for this society');
  const keyChanged = keyId && keyId !== s.own?.keyId;
  if (keyChanged && !keySecret) throw ApiError.badRequest('Enter the key secret that belongs to the new key id');
  if (!keyId && !s.own?.keyId) throw ApiError.badRequest('Enter your Razorpay key id');
  const set = {};
  if (keyId) set['own.keyId'] = keyId;
  if (keySecret) Object.assign(set, { 'own.keySecret': seal(keySecret, SEAL_KEY), 'own.keySecretLast4': last4(keySecret) });
  if (webhookSecret) Object.assign(set, { 'own.webhookSecret': seal(webhookSecret, SEAL_WEBHOOK), 'own.webhookSecretLast4': last4(webhookSecret) });
  const update = { $set: set };
  // New credentials must pass "Test connection" again.
  if (keyChanged || keySecret) update.$unset = { 'own.connection': 1 };
  await PaymentSettings.updateOne({ _id: s._id }, update);
  audit.record(ctx, 'payments.keys_saved', 'PaymentSettings', s._id, { keyId: keyId || s.own?.keyId, keySecret: keySecret ? `…${last4(keySecret)}` : undefined, webhookSecret: webhookSecret ? `…${last4(webhookSecret)}` : undefined });
  return present(await refresh(ctx.societyId, ctx.userId));
}

export async function testConnection(ctx) {
  const s = await ensureDoc(ctx.societyId);
  if (!s.own?.keyId || !s.own?.keySecret) throw ApiError.badRequest('Enter your Razorpay key id and key secret first');
  const gateway = adapterFor({ ...s, mode: 'own' });
  const result = await gateway.testConnection();
  const connection = { ok: Boolean(result.ok), at: new Date(), error: result.ok ? undefined : result.error };
  await PaymentSettings.updateOne({ _id: s._id }, { 'own.connection': connection });
  audit.record(ctx, 'payments.connection_tested', 'PaymentSettings', s._id, { ok: connection.ok, error: connection.error });
  return present(await refresh(ctx.societyId, ctx.userId));
}

// "Test ₹1 payment": a real ₹1 order through the chosen account. The mock provider completes it at once;
// with Razorpay the admin pays it in checkout and the browser calls verifyTestPayment.
export async function startTestPayment(ctx) {
  const s = await ensureDoc(ctx.societyId);
  assertNotBlocked(s);
  if (s.mode === 'disabled') throw ApiError.badRequest('Choose how your society receives payments first');
  const gap = setupGap(s);
  if (gap) throw ApiError.badRequest(gap);
  const gateway = adapterFor(s);
  const order = await gateway.createOrder({ amount: TEST_AMOUNT, receipt: `TEST-${Date.now()}`, notes: { purpose: 'test_payment', society: String(ctx.societyId) } });
  await PaymentSettings.updateOne({ _id: s._id }, { testPayment: { ok: false, at: new Date(), mode: s.mode, amount: TEST_AMOUNT, orderId: order.orderId, error: 'Waiting for the payment' } });
  if (gateway.name === 'mock') {
    const paymentId = `mock_pay_${crypto.randomBytes(8).toString('hex')}`;
    const settings = await verifyTestPayment(ctx, { orderId: order.orderId, paymentId, signature: gateway.sign(order.orderId, paymentId) });
    return { instant: true, order: null, settings };
  }
  return { instant: false, order: { ...order, provider: gateway.name, description: 'ColonyHub test payment' }, settings: present(await loadRaw(ctx.societyId)) };
}

export async function verifyTestPayment(ctx, { orderId, paymentId, signature }) {
  const s = await loadRaw(ctx.societyId);
  if (!s || s.testPayment?.orderId !== orderId) throw ApiError.notFound('Test payment not found');
  const ok = await adapterFor(s).verify({ orderId, paymentId, signature });
  await PaymentSettings.updateOne(
    { _id: s._id },
    { $set: { 'testPayment.ok': ok, 'testPayment.paymentId': paymentId, 'testPayment.at': new Date() }, ...(ok ? { $unset: { 'testPayment.error': 1 } } : { $set: { 'testPayment.error': 'The payment signature did not verify' } }) },
  );
  audit.record(ctx, 'payments.test_payment', 'PaymentSettings', s._id, { ok, mode: s.mode, orderId });
  return present(await loadRaw(ctx.societyId));
}

export async function enable(ctx) {
  const s = await ensureDoc(ctx.societyId);
  assertNotBlocked(s);
  if (s.mode === 'disabled') throw ApiError.badRequest('Choose how your society receives payments first');
  if (s.mode !== 'platform_legacy' && !s.allowedModes.includes(s.mode)) throw ApiError.forbidden('ColonyHub has not enabled this payment mode for your society');
  const gap = setupGap(s);
  if (gap) throw ApiError.badRequest(gap);
  await PaymentSettings.updateOne({ _id: s._id }, { enabled: true });
  audit.record(ctx, 'payments.online_enabled', 'PaymentSettings', s._id, { mode: s.mode });
  return present(await refresh(ctx.societyId, ctx.userId));
}

export async function disable(ctx) {
  const s = await ensureDoc(ctx.societyId);
  await PaymentSettings.updateOne({ _id: s._id }, { enabled: false });
  audit.record(ctx, 'payments.online_disabled', 'PaymentSettings', s._id, { mode: s.mode });
  return present(await refresh(ctx.societyId, ctx.userId));
}

// ---------- platform console ----------
async function assertSociety(societyId) {
  if (!(await Society.exists({ _id: societyId }))) throw ApiError.notFound('Society not found');
}

export async function platformView(societyId) {
  await assertSociety(societyId);
  return present(await loadOrLegacy(societyId));
}

// data: { allowedModes?, forceDisabled?, forceDisabledReason?, route?: { linkedAccountId, status, kycStatus, bank, commissionPercent } }
export async function platformUpdate(platformUser, societyId, data) {
  await assertSociety(societyId);
  const s = await ensureDoc(societyId);
  const set = {};
  const unset = {};
  if (data.allowedModes) set.allowedModes = [...new Set(data.allowedModes)];
  if (data.forceDisabled !== undefined) {
    set.forceDisabled = data.forceDisabled;
    if (data.forceDisabled) Object.assign(set, { forceDisabledReason: data.forceDisabledReason || 'Switched off by ColonyHub', forceDisabledAt: new Date() });
    else Object.assign(unset, { forceDisabledReason: 1, forceDisabledAt: 1 });
  }
  const route = data.route || {};
  for (const k of ['linkedAccountId', 'status', 'kycStatus', 'commissionPercent']) if (route[k] !== undefined) set[`route.${k}`] = route[k];
  for (const [k, v] of Object.entries(route.bank || {})) if (v !== undefined) set[`route.bank.${k}`] = v;
  if (route.linkedAccountId !== undefined && route.linkedAccountId !== s.route?.linkedAccountId && route.status === undefined) set['route.status'] = 'pending';
  await PaymentSettings.updateOne({ _id: s._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { runValidators: true });
  audit.record({ societyId, userId: platformUser._id }, 'platform.payment_settings_updated', 'PaymentSettings', s._id, data);
  return present(await refresh(societyId, platformUser._id));
}

// Reads the linked account's state from Razorpay (platform account) and stores it.
export async function refreshRoute(platformUser, societyId) {
  await assertSociety(societyId);
  const s = await ensureDoc(societyId);
  if (!s.route?.linkedAccountId) throw ApiError.badRequest('Enter the linked account id first');
  const r = await platformProvider.fetchLinkedAccount(s.route.linkedAccountId);
  await PaymentSettings.updateOne({ _id: s._id }, { 'route.status': r.status, 'route.kycStatus': r.kycStatus, 'route.refreshedAt': new Date() });
  audit.record({ societyId, userId: platformUser._id }, 'platform.route_refreshed', 'PaymentSettings', s._id, { status: r.status, kycStatus: r.kycStatus });
  return present(await refresh(societyId, platformUser._id));
}
