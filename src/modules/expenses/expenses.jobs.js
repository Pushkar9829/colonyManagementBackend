import { generateRecurringBills, vendorBillDueReminders } from './payables.service.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export const EXPENSE_JOBS = [
  // hourly so a template's day is picked up soon after IST midnight; generation is once per month per template
  { name: 'expenses-recurring-bills', everyMs: HOUR, run: () => generateRecurringBills() },
  { name: 'expenses-vendor-bill-due', everyMs: 6 * HOUR, run: () => vendorBillDueReminders() },
];
