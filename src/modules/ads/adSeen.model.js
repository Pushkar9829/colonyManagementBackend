import mongoose from 'mongoose';

// The only per-person ad state: when someone last saw the pop-up (for "once" / "daily") and when they closed
// the banner (hidden for the rest of that day). Removed automatically 120 days after the last update.
const adSeenSchema = new mongoose.Schema(
  {
    ad: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastSeenAt: Date, // pop-up shown
    bannerDismissedAt: Date,
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);
adSeenSchema.index({ user: 1, ad: 1 }, { unique: true });
adSeenSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 120 * 86400 });

export default mongoose.model('AdSeen', adSeenSchema);
