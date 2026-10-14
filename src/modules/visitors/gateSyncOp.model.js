import mongoose from 'mongoose';

// One row per offline gate action replayed from a guard's device. The unique key makes retries idempotent:
// when the same key arrives again the stored outcome is returned instead of acting twice.
const gateSyncOpSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    key: { type: String, required: true },
    kind: { type: String, enum: ['entry', 'checkout', 'pass', 'help_scan'], required: true },
    status: { type: String, enum: ['processing', 'ok', 'conflict'], default: 'processing' },
    message: String,
    ref: { type: mongoose.Schema.Types.ObjectId },
    result: mongoose.Schema.Types.Mixed,
    occurredAt: Date,
    gate: { type: mongoose.Schema.Types.ObjectId, ref: 'Gate' }, // the gate the guard was at when it happened
    syncedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
gateSyncOpSchema.index({ society: 1, key: 1 }, { unique: true });

export default mongoose.model('GateSyncOp', gateSyncOpSchema);
