import mongoose from 'mongoose';

// "Leave at gate" instruction from a household: for one delivery company (or all, company = null),
// either standing or for a single day (oneOffDate). The guard sees it and accepts the parcel without approval.
const deliveryPreferenceSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    company: { type: String, trim: true }, // display name; null = any company
    companyKey: { type: String }, // lower-cased for matching
    oneOffDate: { type: String }, // YYYY-MM-DD (IST) for a one-off; null = standing
    usedAt: Date, // a one-off is used up by the first matching delivery
    note: { type: String, trim: true },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
deliveryPreferenceSchema.index({ society: 1, unit: 1, active: 1 });

export default mongoose.model('DeliveryPreference', deliveryPreferenceSchema);
