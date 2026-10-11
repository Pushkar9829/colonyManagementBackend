import mongoose from 'mongoose';

// A household's rating of a helper: one per (helper, unit), editable.
const helpReviewSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    help: { type: mongoose.Schema.Types.ObjectId, ref: 'DailyHelp', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, trim: true },
  },
  { timestamps: true },
);
helpReviewSchema.index({ society: 1, help: 1, unit: 1 }, { unique: true });
helpReviewSchema.index({ society: 1, help: 1, createdAt: -1 });

export default mongoose.model('HelpReview', helpReviewSchema);
