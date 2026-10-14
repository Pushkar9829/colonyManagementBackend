import { closeAndDrawDue, closingReminders } from './luckyDraw.service.js';

// Closes entries and runs draws on time; reminds members ~24h before entries close.
export default [
  { name: 'luckyDraw.lifecycle', everyMs: 60 * 1000, run: () => closeAndDrawDue() },
  { name: 'luckyDraw.reminders', everyMs: 15 * 60 * 1000, run: () => closingReminders() },
];
