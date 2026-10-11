import { runScheduled } from './reports.service.js';

export const REPORT_JOBS = [{ name: 'scheduled-reports', everyMs: 30 * 60 * 1000, run: () => runScheduled() }];
