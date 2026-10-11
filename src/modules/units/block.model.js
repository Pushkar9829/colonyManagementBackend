import mongoose from 'mongoose';

const blockSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true, uppercase: true },
    floors: { type: Number, min: 0 },
  },
  { timestamps: true },
);
blockSchema.index({ society: 1, name: 1 }, { unique: true });

export default mongoose.model('Block', blockSchema);
