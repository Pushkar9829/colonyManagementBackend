import { sendDueReminders } from './parcels.service.js';
import { settingsLookup } from '../visitors/securitySettings.service.js';

export const PARCEL_JOBS = [{ name: 'parcel-reminders', everyMs: 60 * 60 * 1000, run: () => sendDueReminders(settingsLookup) }];
