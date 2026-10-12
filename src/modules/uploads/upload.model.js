import mongoose from 'mongoose';

const uploadSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    folder: { type: String, required: true },
    url: { type: String, required: true },
    key: { type: String, required: true },
    provider: { type: String, required: true },
    mimetype: { type: String, required: true },
    size: { type: Number, required: true },
    name: { type: String, trim: true },
  },
  { timestamps: true },
);
uploadSchema.index({ society: 1, owner: 1, createdAt: -1 });

export default mongoose.model('Upload', uploadSchema);
