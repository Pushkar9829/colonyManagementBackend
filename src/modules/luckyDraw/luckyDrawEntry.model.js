import mongoose from 'mongoose';

// One person's (free) entry in a lucky draw. Withdrawing keeps the row so its id — which feeds the
// verifiable order — stays the same if they enter again.
const entrySchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    draw: { type: mongoose.Schema.Types.ObjectId, ref: 'LuckyDraw', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    name: { type: String, trim: true }, // snapshot at entry time
    unitLabel: String,
    perFlat: { type: Boolean, default: false }, // copied from the draw so the partial index below can see it
    status: { type: String, enum: ['entered', 'withdrawn'], default: 'entered' },
    withdrawnAt: Date,
  },
  { timestamps: true },
);
entrySchema.index({ society: 1, draw: 1, status: 1, createdAt: 1 });
entrySchema.index({ draw: 1, user: 1 }, { unique: true });
// Per-flat draws: at most one active entry per flat. The service checks first; this catches races.
entrySchema.index({ draw: 1, unit: 1 }, { unique: true, partialFilterExpression: { status: 'entered', perFlat: true } });

export default mongoose.model('LuckyDrawEntry', entrySchema);
