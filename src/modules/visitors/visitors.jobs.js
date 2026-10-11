import { escalatePending } from './visitors.service.js';
import { settingsLookup } from './securitySettings.service.js';

// Runs every minute so "no answer in N seconds" escalations land within about a minute of being due.
export const VISITOR_JOBS = [{ name: 'visitor-approval-escalation', everyMs: 60 * 1000, run: () => escalatePending(settingsLookup) }];
