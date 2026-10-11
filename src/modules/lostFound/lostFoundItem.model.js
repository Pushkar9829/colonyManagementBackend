import mongoose from 'mongoose';

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

// A claim is "this is mine" on a found item, or "I found it" on a lost item.
const claimSchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    message: { type: String, trim: true, required: true },
    status: { type: String, enum: ['pending', 'accepted', 'rejected', 'withdrawn'], default: 'pending' },
    decidedAt: Date,
  },
  { timestamps: true },
);

export const LOST_FOUND_CATEGORIES = ['keys', 'wallet', 'phone', 'electronics', 'documents', 'jewellery', 'clothing', 'bag', 'pet', 'toy', 'other'];
export const LOST_FOUND_STATUS = ['open', 'resolved', 'expired', 'closed'];

const lostFoundItemSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    kind: { type: String, enum: ['lost', 'found'], required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String, enum: LOST_FOUND_CATEGORIES, default: 'other' },
    photos: [attachmentSchema],
    location: { type: String, trim: true },
    date: { type: String }, // YYYY-MM-DD (IST) when it was lost / found
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    status: { type: String, enum: LOST_FOUND_STATUS, default: 'open' },
    claims: [claimSchema],
    resolvedWith: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
lostFoundItemSchema.index({ society: 1, status: 1, createdAt: -1 });
lostFoundItemSchema.index({ status: 1, expiresAt: 1 });

export default mongoose.model('LostFoundItem', lostFoundItemSchema);
