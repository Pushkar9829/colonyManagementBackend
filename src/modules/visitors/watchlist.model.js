import mongoose from 'mongoose';

// Society-wide blocklist / watchlist checked at the gate.
// block = refuse entry; watch = allow but flag the entry and alert guards and management.
const watchlistSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    type: { type: String, enum: ['block', 'watch'], required: true },
    name: { type: String, trim: true },
    nameKey: { type: String }, // lower-cased name for exact matching
    phone: { type: String, trim: true },
    phoneKey: { type: String }, // last 10 digits
    vehicleNumber: { type: String, trim: true, uppercase: true }, // stored without spaces
    photoUrl: { type: String },
    reason: { type: String, required: true, trim: true },
    expiresAt: Date,
    active: { type: Boolean, default: true },
    hits: { type: Number, default: 0 },
    lastHitAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
watchlistSchema.index({ society: 1, active: 1, phoneKey: 1 });
watchlistSchema.index({ society: 1, active: 1, vehicleNumber: 1 });
watchlistSchema.index({ society: 1, active: 1, nameKey: 1 });
watchlistSchema.index({ society: 1, createdAt: -1 });

export default mongoose.model('WatchlistEntry', watchlistSchema);
