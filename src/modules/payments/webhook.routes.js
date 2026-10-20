import express, { Router } from 'express';
import env from '../../config/env.js';
import ApiError from '../../common/errors/ApiError.js';
import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { verifyWebhookSignature } from './providers.js';
import { handleRazorpay } from './webhook.service.js';
import { webhookTarget } from '../paymentSettings/paymentSettings.service.js';

// Mounted before express.json(): the signature is computed over the exact raw body.
// Platform account (subscription invoices, Route and legacy society payments): Razorpay dashboard → Webhooks:
// URL https://<api>/api/v1/payments/webhook/razorpay, the secret in RAZORPAY_WEBHOOK_SECRET, events
// payment.captured, payment.failed, order.paid and token.*.
// A society on its own gateway adds https://<api>/api/v1/payments/webhook/razorpay/<its webhook key> in its
// own Razorpay dashboard with the webhook secret it saved in Settings → Online payments.
const router = Router();

function parse(raw) {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw ApiError.badRequest('Invalid JSON');
  }
}

router.post(
  '/razorpay',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    if (!env.RAZORPAY_WEBHOOK_SECRET) throw ApiError.notFound();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyWebhookSignature(raw, req.get('x-razorpay-signature'), env.RAZORPAY_WEBHOOK_SECRET)) {
      throw ApiError.badRequest('Invalid webhook signature');
    }
    // Errors fall through to the error handler (5xx), so Razorpay retries the delivery.
    res.json({ success: true, data: await handleRazorpay(parse(raw), req.get('x-razorpay-event-id')) });
  }),
);

router.post(
  '/razorpay/:societyKey',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const key = String(req.params.societyKey);
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(key)) throw ApiError.notFound();
    const target = await webhookTarget(key);
    if (!target) throw ApiError.notFound();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyWebhookSignature(raw, req.get('x-razorpay-signature'), target.secret)) throw ApiError.badRequest('Invalid webhook signature');
    res.json({ success: true, data: await handleRazorpay(parse(raw), req.get('x-razorpay-event-id'), { societyId: target.societyId, key }) });
  }),
);

export default router;
