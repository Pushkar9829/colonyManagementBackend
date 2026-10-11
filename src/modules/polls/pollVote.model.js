import mongoose from 'mongoose';

// One vote per unit (household) per poll; staff without a unit vote per user.
const pollVoteSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    poll: { type: mongoose.Schema.Types.ObjectId, ref: 'Poll', required: true },
    voterKey: { type: String, required: true }, // "unit:<id>" or "user:<id>"
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    optionIndex: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
pollVoteSchema.index({ poll: 1, voterKey: 1 }, { unique: true });

export default mongoose.model('PollVote', pollVoteSchema);
