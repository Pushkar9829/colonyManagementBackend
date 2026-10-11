import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Who downloaded which version, and when.
const downloadSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    document: { type: ObjectId, ref: 'LibraryDocument', required: true },
    version: Number,
    user: { type: ObjectId, ref: 'User', required: true },
    role: String,
  },
  { timestamps: { createdAt: 'at', updatedAt: false } },
);
downloadSchema.index({ society: 1, document: 1, at: -1 });

export default mongoose.model('DocumentDownload', downloadSchema);
