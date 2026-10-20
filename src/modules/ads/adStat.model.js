import mongoose from 'mongoose';

// Counters per ad per IST day. Kept as aggregates on purpose: no per-person rows for numbers.
const adStatSchema = new mongoose.Schema(
  {
    ad: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', required: true },
    day: { type: String, required: true }, // YYYY-MM-DD (IST)
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    dismissals: { type: Number, default: 0 },
  },
  { timestamps: false },
);
adStatSchema.index({ ad: 1, day: 1 }, { unique: true });

export default mongoose.model('AdStat', adStatSchema);
