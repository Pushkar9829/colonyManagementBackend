import crypto from 'node:crypto';
import WebhookEvent from './webhookEvent.model.js';
import logger from '../../common/utils/logger.js';
import * as autopay from './autopay.service.js';
import * as payments from './payments.service.js';
import * as amenities from '../amenities/amenities.service.js';
import * as events from '../events/events.service.js';
import * as subscriptions from '../subscriptions/subscriptions.service.js';

// Every checkout that can be paid online, tried in order. Each returns false when the order isn't
// one of its own, and is idempotent (the browser's verify call may already have settled it).
const CAPTURE_HANDLERS = [
  ['mandate', autopay.onAuthorisationCaptured],
  ['autopay', (p) => autopay.onChargeEvent({ ...p, status: 'captured' })],
  ['bill', payments.captureByOrder],
  ['amenity', amenities.captureByOrder],
  ['event', events.captureByOrder],
  ['subscription', subscriptions.captureByOrder],
];

// societyId: the delivery came to a society's own-gateway webhook, so only that society's orders match and
// platform subscription invoices (always paid into the platform account) are never settled from it.
async function onCaptured(payment, societyId) {
  if (!payment?.order_id) return 'ignored';
  const args = { orderId: payment.order_id, paymentId: payment.id, societyId };
  for (const [name, handler] of CAPTURE_HANDLERS) {
    if (societyId && name === 'subscription') continue;
    // eslint-disable-next-line no-await-in-loop
    if (await handler(args)) return name;
  }
  return 'unknown-order';
}

// Only recurring debits need a failed event: a failed checkout attempt can be retried on the same order.
async function onFailed(payment, societyId) {
  if (!payment?.order_id) return 'ignored';
  const matched = await autopay.onChargeEvent({ orderId: payment.order_id, status: 'failed', error: payment.error_description || 'Payment failed', societyId });
  return matched ? 'autopay' : 'ignored';
}

// Handles one verified Razorpay webhook delivery. `eventId` is the X-Razorpay-Event-Id header.
// society: { societyId, key } when it arrived on a society's own-gateway webhook (event ids are per account).
export async function handleRazorpay(body, eventId, society = null) {
  const id = eventId || crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const source = society ? `razorpay:${society.key}` : 'razorpay';
  const societyId = society?.societyId;
  if (await WebhookEvent.exists({ provider: source, eventId: id })) return { event: body.event, handled: 'duplicate' };

  const payment = body.payload?.payment?.entity;
  let handled = 'ignored';
  switch (body.event) {
    case 'payment.captured':
    case 'order.paid':
      handled = await onCaptured(payment, societyId);
      break;
    case 'payment.failed':
      handled = await onFailed(payment, societyId);
      break;
    case 'token.confirmed':
    case 'token.rejected':
    case 'token.cancelled':
    case 'token.paused':
      await autopay.onTokenEvent(body.event, body.payload?.token?.entity?.id, societyId);
      handled = 'mandate';
      break;
    default:
      break;
  }
  if (handled === 'unknown-order') logger.warn({ event: body.event, order: payment?.order_id }, 'webhook for an order this API did not create');

  // Recorded after processing, so a delivery that errored is processed again on Razorpay's retry.
  await WebhookEvent.create({ provider: source, eventId: id, event: body.event, handled }).catch((err) => {
    if (err.code !== 11000) throw err;
  });
  return { event: body.event, handled };
}
