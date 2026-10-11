import { markAbsences } from './attendance.service.js';

const HOUR = 60 * 60 * 1000;

// Marks yesterday's no-shows absent (and rostered days off as week off). Idempotent, so it can run often.
export const STAFFHR_JOBS = [{ name: 'staffhr-mark-absences', everyMs: 3 * HOUR, run: () => markAbsences() }];
