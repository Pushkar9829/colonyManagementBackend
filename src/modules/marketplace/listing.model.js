import mongoose from 'mongoose';

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

export const LISTING_TYPES = ['sell', 'buy', 'rent', 'free', 'services'];
export const LISTING_CATEGORIES = ['furniture', 'electronics', 'appliances', 'vehicles', 'books', 'kids', 'clothing', 'sports', 'home', 'property', 'services', 'other'];
export const LISTING_CONDITIONS = ['new', 'like_new', 'good', 'fair', 'not_applicable'];
export const PRICE_UNITS = ['total', 'per_hour', 'per_day', 'per_month'];
export const LISTING_STATUS = ['active', 'sold', 'closed', 'removed'];

const listingSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    type: { type: String, enum: LISTING_TYPES, required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String, enum: LISTING_CATEGORIES, default: 'other' },
    condition: { type: String, enum: LISTING_CONDITIONS, default: 'not_applicable' },
    price: { type: Number, min: 0, default: 0 }, // paise; 0 for free / on request
    priceUnit: { type: String, enum: PRICE_UNITS, default: 'total' },
    negotiable: { type: Boolean, default: false },
    photos: [attachmentSchema],
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    // buyers reach the seller through in-app chat; the phone is shown only if the seller opts in
    showPhone: { type: Boolean, default: false },
    status: { type: String, enum: LISTING_STATUS, default: 'active' },
    soldAt: Date,
    removedReason: String,
    reportCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);
listingSchema.index({ society: 1, status: 1, createdAt: -1 });
listingSchema.index({ society: 1, seller: 1, createdAt: -1 });

export default mongoose.model('Listing', listingSchema);
