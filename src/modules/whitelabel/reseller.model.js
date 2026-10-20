import mongoose from 'mongoose';

// A white-label partner: buys licence keys in packs and hands them to the societies it signs up.
// Those societies show the partner's brand (app name, logo, colour) instead of ColonyHub's.
const resellerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true }, // ?brand=<slug> on the login page
    brand: {
      appName: { type: String, trim: true },
      logoUrl: { type: String, trim: true },
      primaryColor: { type: String, trim: true }, // #rrggbb
      supportEmail: { type: String, trim: true, lowercase: true },
      supportPhone: { type: String, trim: true },
      customDomain: { type: String, trim: true, lowercase: true }, // host name only, e.g. app.smartnest.in
    },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    contact: {
      name: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      phone: { type: String, trim: true },
    },
    keysPurchased: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
resellerSchema.index({ 'brand.customDomain': 1 }, { unique: true, partialFilterExpression: { 'brand.customDomain': { $type: 'string' } } });

export default mongoose.model('Reseller', resellerSchema);
