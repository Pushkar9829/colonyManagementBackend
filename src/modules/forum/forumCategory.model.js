import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const categorySchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
categorySchema.index({ society: 1, name: 1 }, { unique: true });

export default mongoose.model('ForumCategory', categorySchema);
