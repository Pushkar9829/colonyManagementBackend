import { runEscalations } from './helpdesk.service.js';

export const COMPLAINT_JOBS = [{ name: 'complaint-escalation-matrix', everyMs: 15 * 60 * 1000, run: () => runEscalations() }];
