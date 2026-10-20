import mongoose from 'mongoose';

const chargeHeadSchema = new mongoose.Schema({ name: { type: String, required: true, trim: true }, amount: { type: Number, required: true, min: 0 } }, { _id: false });

const societySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    contactEmail: { type: String, trim: true, lowercase: true },
    contactPhone: { type: String, trim: true },
    settings: {
      billing: {
        // amounts in paise
        perSqftRate: { type: Number, default: 0, min: 0 },
        fixedAmount: { type: Number, default: 0, min: 0 },
        chargeHeads: { type: [chargeHeadSchema], default: [] },
        dueDays: { type: Number, default: 15, min: 0 },
        autoGenerate: { type: Boolean, default: false }, // scheduler creates bills each month
        generateDay: { type: Number, default: 1, min: 1, max: 28 },
        lateFeeType: { type: String, enum: ['none', 'flat', 'percent'], default: 'none' },
        lateFeeValue: { type: Number, default: 0, min: 0 }, // paise for flat, percent otherwise
      },
      complaintSlaHours: {
        low: { type: Number, default: 72 },
        medium: { type: Number, default: 48 },
        high: { type: Number, default: 24 },
        urgent: { type: Number, default: 4 },
      },
      visitorApprovalRequired: { type: Boolean, default: true },
      security: {
        requireMfa: { type: Boolean, default: false }, // admins and accountants must use two-step verification
      },
    },
    active: { type: Boolean, default: true },
    // Set by the platform owner (super admin console)
    plan: {
      // 'trial': everything on for a limited time after sign-up, then behaves as free
      name: { type: String, enum: ['trial', 'free', 'basic', 'standard', 'premium'], default: 'free' },
      unitLimit: { type: Number, default: 50 }, // null = unlimited
      validUntil: Date,
    },
    // set when the admin hides the first-run setup checklist on the dashboard
    setupChecklistDismissedAt: Date,
    suspendedReason: { type: String, trim: true },
    platformNotes: { type: String, trim: true },
    // White-label partner whose licence key activated this society (modules/whitelabel); its branding applies.
    reseller: { type: mongoose.Schema.Types.ObjectId, ref: 'Reseller', index: true },
  },
  { timestamps: true },
);

export default mongoose.model('Society', societySchema);
