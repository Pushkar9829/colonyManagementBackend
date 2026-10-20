import crypto from 'node:crypto';
import env from '../../config/env.js';
import ApiError from '../../common/errors/ApiError.js';

// Payment-provider adapters share one interface:
//   createOrder({ amount, receipt, notes }) -> { orderId, amount, currency, keyId?, transfers? }
//   verify({ orderId, paymentId, signature }) -> boolean
//   refund({ paymentId, amount, notes }) -> { refundId }
//   testConnection() -> { ok, error? }                    cheap authenticated call (society "Test connection")
//   fetchLinkedAccount(accountId) -> { status: 'pending' | 'active' | 'suspended', kycStatus, raw? }   (Route)
// Recurring (autopay) part of the interface:
//   registerMandate({ maxAmount, method, tokenId?, customerId? }) -> { tokenId, customerId }
//   chargeRecurring({ amount, tokenId, customerId, receipt, notes, email, contact })
//       -> { status: 'captured' | 'pending' | 'failed', orderId?, paymentId?, error? }
//   fetchPayment(paymentId) -> { status: 'captured' | 'pending' | 'failed', error? }
// Mandate sign-up (the resident authorises it once in the provider's checkout):
//   startMandate({ maxAmount, method, user, receipt }) -> { orderId, customerId, amount, currency, keyId? }
//   confirmMandate({ orderId, paymentId, signature, customerId })
//       -> { tokenId, customerId, status: 'active' | 'pending' | 'failed', authAmount, error? }
//
// An adapter is bound to one set of credentials (createProvider): the platform's env keys (platform
// subscription invoices, and societies still on 'platform_legacy'), a society's own Razorpay account
// ('own'), or the platform account with Route transfers to the society's linked account ('route').
// PAYMENT_PROVIDER=mock swaps every one of them for the mock, so no real gateway is ever called.

const hex = () => crypto.randomBytes(8).toString('hex');

// Razorpay Route: the order is created on the platform account and `transfers` forwards the society's
// share to its linked account when the payment is captured. The platform commission stays behind.
export function routeTransfers(amount, { account, commissionPercent = 0 }, notes = {}) {
  const commission = Math.round((amount * (Number(commissionPercent) || 0)) / 100);
  return [{ account, amount: amount - commission, currency: 'INR', notes, linked_account_notes: Object.keys(notes).slice(0, 1), on_hold: 0 }];
}

// Recent mock gateway calls with the credentials they used: lets tests prove which account a payment
// went through. Mock only, capped, never holds secrets (just whether one was present and its fingerprint).
export const mockCalls = [];
const fingerprint = (secret) => (secret ? crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 12) : null);
function logMock(creds, op, details = {}) {
  mockCalls.push({ op, keyId: creds.keyId || null, secret: fingerprint(creds.keySecret), account: creds.route?.account || null, at: new Date(), ...details });
  if (mockCalls.length > 500) mockCalls.splice(0, mockCalls.length - 500);
}
export const secretFingerprint = fingerprint;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The mock signature is HMAC(orderId|paymentId) with the account's key secret (the JWT secret for the
// platform), so the client can't forge it without calling a /mock/sign endpoint (dev only), and a
// signature made for one society's account does not verify on another's.
function mockFor(creds = {}) {
  const signingKey = creds.keySecret || env.JWT_ACCESS_SECRET;
  return {
    name: 'mock',
    keyId: creds.keyId || undefined,
    async createOrder({ amount, receipt }) {
      const transfers = creds.route?.account && amount > 0 ? routeTransfers(amount, creds.route, { receipt: String(receipt || '') }) : undefined;
      const order = { orderId: `mock_order_${hex()}`, amount, currency: 'INR', ...(creds.keyId ? { keyId: creds.keyId } : {}), ...(transfers ? { transfers } : {}) };
      logMock(creds, 'createOrder', { amount, orderId: order.orderId, transfers });
      return order;
    },
    sign(orderId, paymentId) {
      return crypto.createHmac('sha256', signingKey).update(`${orderId}|${paymentId}`).digest('hex');
    },
    async verify({ orderId, paymentId, signature }) {
      logMock(creds, 'verify', { orderId });
      return safeEqual(this.sign(orderId, paymentId), signature);
    },
    async refund({ paymentId, amount }) {
      logMock(creds, 'refund', { paymentId, amount, reverseTransfers: Boolean(creds.route?.account) });
      return { refundId: `mock_rfnd_${crypto.randomBytes(6).toString('hex')}` };
    },
    // A key id containing "_bad" simulates wrong credentials (used by tests and the demo).
    async testConnection() {
      logMock(creds, 'testConnection');
      if (String(creds.keyId || '').includes('_bad')) return { ok: false, error: 'Authentication failed: check the key id and secret (mock)' };
      return { ok: true };
    },
    // An account id containing "pending" is still under review in the mock.
    async fetchLinkedAccount(accountId) {
      logMock(creds, 'fetchLinkedAccount', { accountId });
      if (String(accountId).includes('pending')) return { status: 'pending', kycStatus: 'under_review' };
      if (String(accountId).includes('suspended')) return { status: 'suspended', kycStatus: 'rejected' };
      return { status: 'active', kycStatus: 'verified' };
    },
    async registerMandate() {
      logMock(creds, 'registerMandate');
      return { tokenId: `mock_tok_${hex()}`, customerId: `mock_cust_${hex()}` };
    },
    // Captures instantly. A token containing "_fail" simulates a bank decline (used by tests).
    async chargeRecurring({ amount, tokenId }) {
      logMock(creds, 'chargeRecurring', { amount, transfers: creds.route?.account ? routeTransfers(amount, creds.route) : undefined });
      if (String(tokenId).includes('_fail')) return { status: 'failed', error: 'Mandate declined by the bank (mock)' };
      return { status: 'captured', orderId: `mock_order_${hex()}`, paymentId: `mock_pay_${hex()}`, amount };
    },
    async fetchPayment() {
      logMock(creds, 'fetchPayment');
      return { status: 'captured' };
    },
    async startMandate({ method }) {
      logMock(creds, 'startMandate');
      return { orderId: `mock_order_${hex()}`, customerId: `mock_cust_${hex()}`, amount: method === 'upi' ? 100 : 0, currency: 'INR', ...(creds.keyId ? { keyId: creds.keyId } : {}) };
    },
    async confirmMandate({ orderId, paymentId, signature, customerId }) {
      if (!(await this.verify({ orderId, paymentId, signature }))) return { status: 'failed', error: 'Mandate authorisation could not be verified' };
      return { tokenId: `mock_tok_${hex()}`, customerId, status: 'active' };
    },
    async tokenForPayment(_paymentId, customerId) {
      logMock(creds, 'tokenForPayment');
      return { tokenId: `mock_tok_${hex()}`, customerId, status: 'active' };
    },
    async cancelToken() {
      logMock(creds, 'cancelToken');
    },
  };
}

function razorpayFor(creds) {
  const auth = `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64')}`;
  async function rzp(method, path, body, base = 'https://api.razorpay.com/v1') {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }
  const transfersFor = (amount, receipt) => (creds.route?.account && amount > 0 ? { transfers: routeTransfers(amount, creds.route, { receipt: String(receipt || '') }) } : {});

  return {
    name: 'razorpay',
    keyId: creds.keyId,
    async createOrder({ amount, receipt, notes }) {
      const { ok, json: order } = await rzp('POST', '/orders', { amount, currency: 'INR', receipt, notes, ...transfersFor(amount, receipt) });
      if (!ok) throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not create payment order');
      return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: creds.keyId };
    },
    async verify({ orderId, paymentId, signature }) {
      const expected = crypto.createHmac('sha256', creds.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
      return safeEqual(expected, signature);
    },
    // Route: reverse_all pulls the society's share back from the linked account along with the refund.
    async refund({ paymentId, amount, notes }) {
      const { ok, json } = await rzp('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount, notes, ...(creds.route?.account ? { reverse_all: 1 } : {}) });
      if (!ok) throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'The refund could not be processed. Try again later.');
      return { refundId: json.id };
    },
    // Listing one order is the cheapest call that proves the key id + secret pair works.
    async testConnection() {
      try {
        const { ok, status, json } = await rzp('GET', '/orders?count=1');
        if (ok) return { ok: true };
        return { ok: false, error: status === 401 ? 'Authentication failed: check the key id and secret' : json?.error?.description || `Razorpay answered ${status}` };
      } catch {
        return { ok: false, error: 'Could not reach Razorpay' };
      }
    },
    async fetchLinkedAccount(accountId) {
      const { ok, json } = await rzp('GET', `/accounts/${encodeURIComponent(accountId)}`, undefined, 'https://api.razorpay.com/v2');
      if (!ok) throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', json?.error?.description || 'Could not read the linked account');
      const state = json.status;
      const status = state === 'activated' ? 'active' : ['suspended', 'rejected'].includes(state) ? 'suspended' : 'pending';
      return { status, kycStatus: state, raw: { id: json.id, status: state } };
    },

    // ---- Recurring payments (UPI AutoPay / e-NACH) ----
    // The mandate itself is authorised by the resident in Razorpay Checkout (an "authorisation
    // transaction" with a customer_id and recurring=1). Razorpay then issues a token (token_xxx) for that
    // customer (cust_xxx). Those two ids are what this adapter stores; it does not run the checkout itself.
    async registerMandate() {
      throw ApiError.badRequest('Set up autopay through the bank authorisation step (Set up autopay)');
    },
    // Charges a subsequent payment on an existing token: create an order, then
    // POST /v1/payments/create/recurring. Razorpay settles recurring debits asynchronously, so the result is
    // 'pending' and the autopay-reconcile job confirms it with fetchPayment().
    async chargeRecurring({ amount, tokenId, customerId, receipt, notes, email, contact }) {
      const order = await rzp('POST', '/orders', { amount, currency: 'INR', receipt, notes, payment_capture: true, ...transfersFor(amount, receipt) });
      if (!order.ok) return { status: 'failed', error: order.json?.error?.description || 'Could not create the order' };
      const pay = await rzp('POST', '/payments/create/recurring', {
        email,
        contact,
        amount,
        currency: 'INR',
        order_id: order.json.id,
        customer_id: customerId,
        token: tokenId,
        recurring: '1',
        description: receipt,
        notes,
      });
      if (!pay.ok) return { status: 'failed', orderId: order.json.id, error: pay.json?.error?.description || 'Recurring charge was declined' };
      return { status: 'pending', orderId: order.json.id, paymentId: pay.json.razorpay_payment_id };
    },
    async fetchPayment(paymentId) {
      const { ok, json } = await rzp('GET', `/payments/${encodeURIComponent(paymentId)}`);
      if (!ok) return { status: 'pending' };
      if (json.status === 'captured') return { status: 'captured' };
      if (json.status === 'failed') return { status: 'failed', error: json.error_description || 'Payment failed' };
      return { status: 'pending' };
    },

    // Authorisation transaction: a customer plus an order carrying the token terms. Checkout is then opened
    // with { order_id, customer_id, recurring: '1' }. UPI AutoPay authorises with a ₹1 debit (credited to the
    // home as advance); e-NACH authorises with ₹0 and the bank confirms the mandate a few days later.
    async startMandate({ maxAmount, method, user, receipt }) {
      const cust = await rzp('POST', '/customers', { name: user.name, email: user.email, contact: user.phone, fail_existing: '0' });
      if (!cust.ok) throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', cust.json?.error?.description || 'Could not create the payment customer');
      const amount = method === 'upi' ? 100 : 0;
      const expireAt = Math.floor(Date.now() / 1000) + 10 * 365 * 86400;
      const order = await rzp('POST', '/orders', {
        amount,
        currency: 'INR',
        customer_id: cust.json.id,
        method: method === 'upi' ? 'upi' : 'emandate',
        payment_capture: true,
        receipt,
        token: { max_amount: maxAmount, expire_at: expireAt, frequency: 'as_presented' },
        ...transfersFor(amount, receipt),
      });
      if (!order.ok) throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', order.json?.error?.description || 'Could not start the mandate');
      return { orderId: order.json.id, customerId: cust.json.id, amount, currency: 'INR', keyId: creds.keyId };
    },
    async confirmMandate({ orderId, paymentId, signature, customerId }) {
      if (!(await this.verify({ orderId, paymentId, signature }))) return { status: 'failed', error: 'Mandate authorisation could not be verified' };
      return this.tokenForPayment(paymentId, customerId);
    },
    // Reads the token a recurring authorisation payment created, and whether the bank has confirmed it.
    async tokenForPayment(paymentId, customerId) {
      const pay = await rzp('GET', `/payments/${encodeURIComponent(paymentId)}`);
      const tokenId = pay.json?.token_id;
      if (!pay.ok || !tokenId) return { status: 'failed', error: 'No mandate was created for this payment' };
      const cust = pay.json.customer_id || customerId;
      const tok = await rzp('GET', `/customers/${encodeURIComponent(cust)}/tokens/${encodeURIComponent(tokenId)}`);
      const state = tok.json?.recurring_details?.status;
      if (state === 'rejected' || state === 'cancelled') return { status: 'failed', tokenId, customerId: cust, error: tok.json?.recurring_details?.failure_reason || 'The bank rejected the mandate' };
      return { tokenId, customerId: cust, status: state === 'confirmed' ? 'active' : 'pending', authAmount: pay.json.status === 'captured' ? pay.json.amount : 0 };
    },
    // Stops the bank honouring further debits. Best effort: the mandate is already off on our side.
    async cancelToken({ tokenId, customerId }) {
      if (!tokenId || !customerId) return;
      await rzp('DELETE', `/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(tokenId)}`);
    },
  };
}

// creds: { keyId, keySecret, route?: { account, commissionPercent } }.
export function createProvider(creds = {}) {
  return env.PAYMENT_PROVIDER === 'razorpay' ? razorpayFor(creds) : mockFor(creds);
}

// Razorpay signs webhook bodies with HMAC-SHA256(raw body, webhook secret) in X-Razorpay-Signature.
export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  return safeEqual(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), signature);
}

const PLATFORM_CREDS = { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET };

// The platform's own account (env keys): subscription invoices, Route orders and 'platform_legacy' societies.
export const provider = env.PAYMENT_PROVIDER === 'razorpay' ? razorpayFor(PLATFORM_CREDS) : mockFor({});
export const mockProvider = mockFor({});
// Route orders: the platform account plus transfers to one linked account.
export const platformRouteProvider = (route) => createProvider({ ...PLATFORM_CREDS, route });
