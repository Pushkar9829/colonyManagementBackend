import mongoose from 'mongoose';

// Per society + source collection: how far the automatic posting sync has read (by updatedAt).
const syncStateSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    source: { type: String, required: true },
    cursor: { type: Date },
    lastRunAt: { type: Date },
    lastResult: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);
syncStateSchema.index({ society: 1, source: 1 }, { unique: true });

export default mongoose.model('AccountingSyncState', syncStateSchema);
