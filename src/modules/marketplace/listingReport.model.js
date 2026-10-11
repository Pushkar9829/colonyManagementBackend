import mongoose from 'mongoose';

// A member flagging a listing (scam, prohibited item, offensive...). One report per member per listing.
const listingReportSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    listing: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: ['spam', 'scam', 'prohibited', 'offensive', 'wrong_category', 'other'], required: true },
    note: { type: String, trim: true },
    status: { type: String, enum: ['open', 'dismissed', 'actioned'], default: 'open' },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
  },
  { timestamps: true },
);
listingReportSchema.index({ society: 1, listing: 1, reporter: 1 }, { unique: true });
listingReportSchema.index({ society: 1, status: 1, createdAt: -1 });

export default mongoose.model('ListingReport', listingReportSchema);
