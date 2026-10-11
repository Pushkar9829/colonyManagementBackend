import mongoose from 'mongoose';

export const DEFAULT_FOLDERS = ['Bye-laws', 'Audit reports', 'AGM minutes', 'Agreements', 'NOCs', 'Insurance', 'Plans & drawings', 'Circulars'];

const folderSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true },
    system: { type: Boolean, default: false }, // one of the default folders
    order: { type: Number, default: 100 },
  },
  { timestamps: true },
);
folderSchema.index({ society: 1, slug: 1 }, { unique: true });

export default mongoose.model('DocumentFolder', folderSchema);
