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
  async registerMandate({ tokenId, customerId }) {
    if (!tokenId || !customerId) {
      throw ApiError.badRequest('Authorise the mandate in Razorpay Checkout first, then send its tokenId and customerId');
    }
    return { tokenId, customerId };
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
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const provider = env.PAYMENT_PROVIDER === 'razorpay' ? razorpay : mock;
export const mockProvider = mock;
