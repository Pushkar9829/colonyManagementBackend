import express, { Router } from 'express';
import env from '../../config/env.js';
import ApiError from '../../common/errors/ApiError.js';
import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { verifyWebhookSignature } from './providers.js';
import { handleRazorpay } from './webhook.service.js';

// Mounted before express.json(): the signature is computed over the exact raw body.
// Razorpay dashboard → Webhooks: URL https://<api>/api/v1/payments/webhook/razorpay, the secret in
// RAZORPAY_WEBHOOK_SECRET, events payment.captured, payment.failed, order.paid and token.*.
const router = Router();

router.post(
  '/razorpay',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    if (!env.RAZORPAY_WEBHOOK_SECRET) throw ApiError.notFound();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyWebhookSignature(raw, req.get('x-razorpay-signature'), env.RAZORPAY_WEBHOOK_SECRET)) {
      throw ApiError.badRequest('Invalid webhook signature');
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw ApiError.badRequest('Invalid JSON');
    }
    // Errors fall through to the error handler (5xx), so Razorpay retries the delivery.
    res.json({ success: true, data: await handleRazorpay(body, req.get('x-razorpay-event-id')) });
  }),
);

export default router;
