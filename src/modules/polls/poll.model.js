import mongoose from 'mongoose';

const pollSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    question: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    options: [{ text: { type: String, required: true, trim: true }, votes: { type: Number, default: 0 } }],
    audience: {
      type: { type: String, enum: ['all', 'blocks', 'roles'], default: 'all' },
      blocks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Block' }],
      roles: [String],
    },
    anonymous: { type: Boolean, default: false },
    closesAt: Date,
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
pollSchema.index({ society: 1, status: 1, createdAt: -1 });

export default mongoose.model('Poll', pollSchema);
