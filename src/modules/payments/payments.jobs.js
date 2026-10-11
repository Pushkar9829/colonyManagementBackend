import { reconcilePending } from './autopay.service.js';

// Recurring debits (Razorpay UPI AutoPay / e-NACH) settle asynchronously; confirm them every 15 minutes.
export default [{ name: 'autopay-reconcile', everyMs: 15 * 60 * 1000, run: reconcilePending }];
