import { expiryReminders } from './tenancy.service.js';

const HOUR = 60 * 60 * 1000;

export const TENANCY_JOBS = [{ name: 'lease-expiry-reminders', everyMs: 6 * HOUR, run: () => expiryReminders() }];
