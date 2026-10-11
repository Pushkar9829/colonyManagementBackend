import PpmSchedule from './ppmSchedule.model.js';
import Society from '../society/society.model.js';
import { generateForSchedule, sweepOverdue } from './maintenance.service.js';
import { generateAllRuns, sweepMissed } from './housekeeping.service.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Creates PPM tasks up to each schedule's lead time.
export async function generatePpmTasks(now = new Date()) {
  const societies = (await Society.find({ active: true }).select('_id').lean()).map((s) => s._id);
  const schedules = await PpmSchedule.find({ society: { $in: societies }, active: true }).lean();
  let created = 0;
  // eslint-disable-next-line no-await-in-loop
  for (const s of schedules) created += await generateForSchedule(s, now);
  return { schedules: schedules.length, created };
}

export const MAINTENANCE_JOBS = [
  { name: 'facility-ppm-generate', everyMs: 3 * HOUR, run: () => generatePpmTasks() },
  { name: 'facility-ppm-overdue', everyMs: HOUR, run: () => sweepOverdue() },
  { name: 'facility-checklist-generate', everyMs: 3 * HOUR, run: () => generateAllRuns() },
  { name: 'facility-checklist-missed', everyMs: 15 * MIN, run: () => sweepMissed() },
];
