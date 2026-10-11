import mongoose from 'mongoose';
import { BILLING_CYCLES, DEFAULT_DUE_DAYS, DEFAULT_GRACE_DAYS } from './subscriptions.constants.js';

// The platform's billing state for one society. Kept out of the Society model on purpose
// (that model belongs to the society module); Society.plan.validUntil mirrors paidUntil.
const subscriptionSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true, unique: true },
    billingCycle: { type: String, enum: BILLING_CYCLES, default: 'monthly' },
    billedUntil: Date, // end of the last invoiced period; the next invoice starts here
    paidUntil: Date,
    dueDays: { type: Number, default: DEFAULT_DUE_DAYS, min: 0, max: 60 },
    graceDays: { type: Number, default: DEFAULT_GRACE_DAYS, min: 0, max: 90 },
    status: { type: String, enum: ['active', 'past_due', 'suspended'], default: 'active' },
    // Set when the dunning job suspended the society, so a payment only lifts suspensions it caused.
    autoSuspendReason: { type: String },
    suspendedAt: Date,
    billingEmail: { type: String, trim: true, lowercase: true },
    gstin: { type: String, trim: true, uppercase: true },
  },
  { timestamps: true },
);

export default mongoose.model('Subscription', subscriptionSchema);
