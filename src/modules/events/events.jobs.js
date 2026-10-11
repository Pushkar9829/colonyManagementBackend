import { sendReminders } from './events.service.js';

// Reminds attendees ~24 hours before each event starts.
export default [{ name: 'events.reminders', everyMs: 15 * 60 * 1000, run: () => sendReminders() }];
