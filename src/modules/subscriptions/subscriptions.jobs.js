import { generateDueInvoices, runDunning } from './subscriptions.service.js';

const HOUR = 60 * 60 * 1000;

export const SUBSCRIPTION_JOBS = [
  { name: 'platform-invoices', everyMs: 6 * HOUR, run: () => generateDueInvoices() },
  { name: 'subscription-dunning', everyMs: 6 * HOUR, run: () => runDunning() },
];
