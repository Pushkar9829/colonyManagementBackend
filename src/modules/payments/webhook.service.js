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

async function onCaptured(payment) {
  if (!payment?.order_id) return 'ignored';
  const args = { orderId: payment.order_id, paymentId: payment.id };
  for (const [name, handler] of CAPTURE_HANDLERS) {
    // eslint-disable-next-line no-await-in-loop
    if (await handler(args)) return name;
  }
  return 'unknown-order';
}

// Only recurring debits need a failed event: a failed checkout attempt can be retried on the same order.
async function onFailed(payment) {
  if (!payment?.order_id) return 'ignored';
  const matched = await autopay.onChargeEvent({ orderId: payment.order_id, status: 'failed', error: payment.error_description || 'Payment failed' });
  return matched ? 'autopay' : 'ignored';
}

// Handles one verified Razorpay webhook delivery. `eventId` is the X-Razorpay-Event-Id header.
export async function handleRazorpay(body, eventId) {
  const id = eventId || crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  if (await WebhookEvent.exists({ provider: 'razorpay', eventId: id })) return { event: body.event, handled: 'duplicate' };

  const payment = body.payload?.payment?.entity;
  let handled = 'ignored';
  switch (body.event) {
    case 'payment.captured':
    case 'order.paid':
      handled = await onCaptured(payment);
      break;
    case 'payment.failed':
      handled = await onFailed(payment);
      break;
    case 'token.confirmed':
    case 'token.rejected':
    case 'token.cancelled':
    case 'token.paused':
      await autopay.onTokenEvent(body.event, body.payload?.token?.entity?.id);
      handled = 'mandate';
      break;
    default:
      break;
  }
  if (handled === 'unknown-order') logger.warn({ event: body.event, order: payment?.order_id }, 'webhook for an order this API did not create');

  // Recorded after processing, so a delivery that errored is processed again on Razorpay's retry.
  await WebhookEvent.create({ provider: 'razorpay', eventId: id, event: body.event, handled }).catch((err) => {
    if (err.code !== 11000) throw err;
  });
  return { event: body.event, handled };
}
