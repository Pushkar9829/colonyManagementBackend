import { autoAbsent, salaryReminders } from './dailyHelp.service.js';

const MIN = 60 * 1000;

export const DAILY_HELP_JOBS = [
  { name: 'help-salary-reminders', everyMs: 6 * 60 * MIN, run: () => salaryReminders() },
  // runs often; does nothing before noon IST and records each helper at most once a day
  { name: 'help-auto-absent', everyMs: 30 * MIN, run: () => autoAbsent() },
];
