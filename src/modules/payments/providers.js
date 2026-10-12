import crypto from 'node:crypto';
import env from '../../config/env.js';
import ApiError from '../../common/errors/ApiError.js';

// Payment-provider adapters share one interface:
//   createOrder({ amount, receipt, notes }) -> { orderId, amount, currency, keyId? }
//   verify({ orderId, paymentId, signature }) -> boolean
// Recurring (autopay) part of the interface:
//   registerMandate({ maxAmount, method, tokenId?, customerId? }) -> { tokenId, customerId }
//   chargeRecurring({ amount, tokenId, customerId, receipt, notes, email, contact })
//       -> { status: 'captured' | 'pending' | 'failed', orderId?, paymentId?, error? }
//   fetchPayment(paymentId) -> { status: 'captured' | 'pending' | 'failed', error? }
// Mandate sign-up (the resident authorises it once in the provider's checkout):
//   startMandate({ maxAmount, method, user, receipt }) -> { orderId, customerId, amount, currency, keyId? }
//   confirmMandate({ orderId, paymentId, signature, customerId })
//       -> { tokenId, customerId, status: 'active' | 'pending' | 'failed', authAmount, error? }

const hex = () => crypto.randomBytes(8).toString('hex');

const mock = {
  name: 'mock',
  async createOrder({ amount }) {
    return { orderId: `mock_order_${hex()}`, amount, currency: 'INR' };
  },
  // The mock signature is HMAC(orderId|paymentId) with the JWT secret, so the client can't forge it
  // without calling /payments/mock/sign (dev only).
  sign(orderId, paymentId) {
    return crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  },
  async verify({ orderId, paymentId, signature }) {
    return safeEqual(this.sign(orderId, paymentId), signature);
  },
  async registerMandate() {
    return { tokenId: `mock_tok_${hex()}`, customerId: `mock_cust_${hex()}` };
  },
  // Captures instantly. A token containing "_fail" simulates a bank decline (used by tests).
  async chargeRecurring({ amount, tokenId }) {
    if (String(tokenId).includes('_fail')) return { status: 'failed', error: 'Mandate declined by the bank (mock)' };
    return { status: 'captured', orderId: `mock_order_${hex()}`, paymentId: `mock_pay_${hex()}`, amount };
  },
  async fetchPayment() {
    return { status: 'captured' };
  },
  async startMandate({ method }) {
    return { orderId: `mock_order_${hex()}`, customerId: `mock_cust_${hex()}`, amount: method === 'upi' ? 100 : 0, currency: 'INR' };
  },
  async confirmMandate({ orderId, paymentId, signature, customerId }) {
    if (!(await this.verify({ orderId, paymentId, signature }))) return { status: 'failed', error: 'Mandate authorisation could not be verified' };
    return { tokenId: `mock_tok_${hex()}`, customerId, status: 'active' };
  },
  async tokenForPayment(_paymentId, customerId) {
    return { tokenId: `mock_tok_${hex()}`, customerId, status: 'active' };
  },
  async cancelToken() {},
};

const rzpAuth = () => `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
async function rzp(method, path, body) {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { Authorization: rzpAuth(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

const razorpay = {
  name: 'razorpay',
  async createOrder({ amount, receipt, notes }) {
    const { ok, json: order } = await rzp('POST', '/orders', { amount, currency: 'INR', receipt, notes });
    if (!ok) throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not create payment order');
    return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: env.RAZORPAY_KEY_ID };
  },
  async verify({ orderId, paymentId, signature }) {
    const expected = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    return safeEqual(expected, signature);
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
    const order = await rzp('POST', '/orders', { amount, currency: 'INR', receipt, notes, payment_capture: true });
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
    });
    if (!order.ok) throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', order.json?.error?.description || 'Could not start the mandate');
    return { orderId: order.json.id, customerId: cust.json.id, amount, currency: 'INR', keyId: env.RAZORPAY_KEY_ID };
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

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Razorpay signs webhook bodies with HMAC-SHA256(raw body, webhook secret) in X-Razorpay-Signature.
export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  return safeEqual(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), signature);
}

export const provider = env.PAYMENT_PROVIDER === 'razorpay' ? razorpay : mock;
export const mockProvider = mock;
