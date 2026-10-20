import mongoose from 'mongoose';

// An uploaded ad image or video. Separate from Upload because platform ads belong to no society.
const adMediaSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['platform', 'society'], required: true },
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society' },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    url: { type: String, required: true },
    key: { type: String, required: true },
    provider: { type: String, required: true },
    mimetype: { type: String, required: true },
    size: { type: Number, required: true },
    name: { type: String, trim: true },
  },
  { timestamps: true },
);
adMediaSchema.index({ owner: 1, createdAt: -1 });

export default mongoose.model('AdMedia', adMediaSchema);
