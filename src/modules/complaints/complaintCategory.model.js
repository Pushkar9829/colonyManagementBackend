import mongoose from 'mongoose';

// Per-society helpdesk category. The built-in categories (COMPLAINT_CATEGORIES) need no document;
// a document with the same key overrides a built-in one (keywords, photo rule, active).
const complaintCategorySchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    key: { type: String, required: true, lowercase: true, trim: true }, // slug stored on complaints
    name: { type: String, required: true, trim: true },
    keywords: { type: [String], default: [] }, // used to suggest the category from a title
    requiresResolutionPhotos: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);
complaintCategorySchema.index({ society: 1, key: 1 }, { unique: true });

export default mongoose.model('ComplaintCategory', complaintCategorySchema);
