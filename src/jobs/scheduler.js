import JobLock from './jobLock.model.js';
import logger from '../common/utils/logger.js';
import { JOBS } from './jobs.js';

const TICK_MS = 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;

// Claims the job if it is due and not locked by another instance. Atomic, so safe with many instances.
async function claim(job, now) {
  await JobLock.updateOne({ _id: job.name }, { $setOnInsert: { lockedUntil: new Date(0) } }, { upsert: true });
  return JobLock.findOneAndUpdate(
    {
      _id: job.name,
      lockedUntil: { $lte: now },
      $or: [{ lastRunAt: null }, { lastRunAt: { $lte: new Date(now.getTime() - job.everyMs) } }],
    },
    { lockedUntil: new Date(now.getTime() + LOCK_MS) },
    { returnDocument: 'after' },
  );
}

export async function runJob(job) {
  const started = Date.now();
  try {
    const result = await job.run();
    await JobLock.updateOne(
      { _id: job.name },
      { lastRunAt: new Date(), lastDurationMs: Date.now() - started, lastError: null, lastResult: result ?? null, lockedUntil: new Date(0) },
      { upsert: true },
    );
    if (result && Object.values(result).some((v) => v)) logger.info({ job: job.name, result }, 'job finished');
    return result;
  } catch (err) {
    logger.error({ err, job: job.name }, 'job failed');
    await JobLock.updateOne({ _id: job.name }, { lastRunAt: new Date(), lastError: err.message, lockedUntil: new Date(0) }, { upsert: true });
    return undefined;
  }
}

async function tick() {
  const now = new Date();
  for (const job of JOBS) {
    // eslint-disable-next-line no-await-in-loop
    if (await claim(job, now).catch(() => null)) await runJob(job);
  }
}

let timer;
export function startScheduler() {
  if (timer) return;
  logger.info({ jobs: JOBS.map((j) => j.name) }, 'scheduler started');
  setTimeout(() => tick().catch((err) => logger.error({ err }, 'scheduler tick failed')), 5000).unref();
  timer = setInterval(() => tick().catch((err) => logger.error({ err }, 'scheduler tick failed')), TICK_MS);
  timer.unref();
}

export function stopScheduler() {
  clearInterval(timer);
  timer = undefined;
}

export const jobStatus = () => JobLock.find().lean();
