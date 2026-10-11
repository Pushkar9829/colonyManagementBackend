import mongoose from 'mongoose';

// One document per job. Acts as a distributed lock (so only one API instance runs a job)
// and remembers when the job last ran (so jobs catch up after the server was asleep).
const jobLockSchema = new mongoose.Schema({
  _id: { type: String }, // job name
  lockedUntil: { type: Date, default: () => new Date(0) },
  lastRunAt: Date,
  lastDurationMs: Number,
  lastError: String,
  lastResult: mongoose.Schema.Types.Mixed,
});

export default mongoose.model('JobLock', jobLockSchema);
