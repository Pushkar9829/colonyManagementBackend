import { overstayAlerts } from './parking.service.js';
import { settingsLookup } from '../visitors/securitySettings.service.js';

export const PARKING_JOBS = [{ name: 'visitor-parking-overstay', everyMs: 5 * 60 * 1000, run: () => overstayAlerts(settingsLookup) }];
