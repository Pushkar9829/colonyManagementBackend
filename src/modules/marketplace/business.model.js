import mongoose from 'mongoose';

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

export const BUSINESS_CATEGORIES = ['tutor', 'tiffin', 'baking', 'beauty', 'fitness', 'repairs', 'tailoring', 'childcare', 'pet_care', 'other'];

// Local business / service run by a member (home tutor, tiffin service...). Visible to the society
// only after the society admin approves it; edits to an approved listing send it back for review.
const businessSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: BUSINESS_CATEGORIES, required: true },
    description: { type: String, trim: true },
    priceNote: { type: String, trim: true }, // "₹3,000 / month, Mon-Fri"
    timings: { type: String, trim: true },
    // a business contact the owner chose to publish (unlike personal numbers, which stay private)
    contactPhone: { type: String, trim: true },
    photos: [attachmentSchema],
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    rejectReason: String,
  },
  { timestamps: true },
);
businessSchema.index({ society: 1, status: 1, category: 1 });

export default mongoose.model('Business', businessSchema);
