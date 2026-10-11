import { expiryReminders } from './documents.service.js';

// Insurance, licences, AMCs: remind the committee before documents expire.
export default [{ name: 'documents-expiry-reminders', everyMs: 6 * 60 * 60 * 1000, run: () => expiryReminders() }];
