import mongoose from 'mongoose';

// A sellable membership, e.g. "Gym — monthly" for 30 days at ₹500.
const passPlanSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    amenity: { type: mongoose.Schema.Types.ObjectId, ref: 'Amenity', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    durationDays: { type: Number, required: true, min: 1, max: 366 },
    price: { type: Number, default: 0, min: 0 }, // paise
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
passPlanSchema.index({ society: 1, amenity: 1, name: 1 }, { unique: true });

export const PASS_STATUS = ['payment_pending', 'active', 'cancelled', 'expired'];

// One member's pass. `code` is what the QR encodes and what the guard/manager checks at the door.
const amenityPassSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    amenity: { type: mongoose.Schema.Types.ObjectId, ref: 'Amenity', required: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'AmenityPassPlan', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    holder: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    purchasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    code: { type: String, required: true },
    validFrom: { type: String, required: true }, // YYYY-MM-DD, inclusive
    validTo: { type: String, required: true }, // YYYY-MM-DD, inclusive
    price: { type: Number, default: 0 },
    status: { type: String, enum: PASS_STATUS, default: 'active' },
    paymentStatus: { type: String, enum: ['not_required', 'pending', 'pay_at_desk', 'paid', 'refunded'], default: 'not_required' },
    paymentDueAt: Date,
    entries: { type: Number, default: 0 },
    lastEntryAt: Date,
    cancelledAt: Date,
    cancelReason: String,
  },
  { timestamps: true },
);
amenityPassSchema.index({ society: 1, code: 1 }, { unique: true });
amenityPassSchema.index({ society: 1, holder: 1, amenity: 1, status: 1 });
amenityPassSchema.index({ status: 1, validTo: 1 });

export const AmenityPassPlan = mongoose.model('AmenityPassPlan', passPlanSchema);
export default mongoose.model('AmenityPass', amenityPassSchema);
