import { escalateAlerts } from './emergency.service.js';
import { settingsLookup } from '../visitors/securitySettings.service.js';

export const EMERGENCY_JOBS = [{ name: 'child-exit-alert-escalation', everyMs: 60 * 1000, run: () => escalateAlerts(settingsLookup) }];
