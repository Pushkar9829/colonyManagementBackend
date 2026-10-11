import { slaEscalations } from './support.service.js';

export const SUPPORT_JOBS = [{ name: 'support-sla', everyMs: 15 * 60 * 1000, run: () => slaEscalations() }];
