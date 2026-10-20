import mongoose from 'mongoose';
import { BILLING_CYCLES } from '../subscriptions/subscriptions.constants.js';

export const KEY_PLANS = ['basic', 'standard', 'premium'];
export const KEY_STATUSES = ['unused', 'active', 'revoked'];

// One licence key. Only a keyed hash is stored (common/utils/secretBox.keyedHash); the full key is shown
// once when it is generated. The key prepays `plan` for one `cycle` term (one_time: validityMonths, or
// lifetime when validityMonths is empty) from the day a society activates it.
const licenceKeySchema = new mongoose.Schema(
  {
    reseller: { type: mongoose.Schema.Types.ObjectId, ref: 'Reseller', required: true },
    keyHash: { type: String, required: true, unique: true, select: false },
    last4: { type: String, required: true },
    plan: { type: String, enum: KEY_PLANS, required: true },
    cycle: { type: String, enum: BILLING_CYCLES, required: true },
    validityMonths: { type: Number, min: 1, max: 120, default: null }, // one_time only; null = lifetime
    status: { type: String, enum: KEY_STATUSES, default: 'unused' },
    batch: { type: String, required: true }, // generation run
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'ResellerInvoice' },
    activatedSociety: { type: mongoose.Schema.Types.ObjectId, ref: 'Society' },
    activatedAt: Date,
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    expiresAt: Date, // end of the prepaid term, set on activation
    revokedAt: Date,
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
licenceKeySchema.index({ reseller: 1, status: 1, createdAt: -1 });
licenceKeySchema.index({ activatedSociety: 1 });

export default mongoose.model('LicenceKey', licenceKeySchema);
