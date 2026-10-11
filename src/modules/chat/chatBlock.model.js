import mongoose from 'mongoose';

// "blocker" no longer receives direct messages from "blocked" (and can't send to them either).
const chatBlockSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    blocker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    blocked: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
chatBlockSchema.index({ society: 1, blocker: 1, blocked: 1 }, { unique: true });

export default mongoose.model('ChatBlock', chatBlockSchema);
