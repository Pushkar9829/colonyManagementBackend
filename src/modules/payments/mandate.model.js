import mongoose from 'mongoose';

// A resident's standing instruction to pay each new bill automatically (UPI AutoPay / e-NACH).
// `tokenId` / `customerId` are the provider's recurring token and customer (Razorpay: token_xxx / cust_xxx),
// obtained when the resident authorises the mandate in the provider's checkout.
const mandateSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    method: { type: String, enum: ['upi', 'enach'], default: 'upi' },
    maxAmount: { type: Number, required: true, min: 100 }, // paise; bills above this are left for manual payment
    provider: { type: String, required: true },
    tokenId: { type: String, required: true },
    customerId: { type: String },
    status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
    lastChargedAt: Date,
    lastResult: { type: String, enum: ['success', 'failed', 'pending', 'skipped'] },
    lastError: { type: String },
    failures: { type: Number, default: 0 }, // consecutive
    cancelledAt: Date,
  },
  { timestamps: true },
);
// At most one live mandate per unit, so a bill is never charged twice.
mandateSchema.index({ society: 1, unit: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
mandateSchema.index({ society: 1, status: 1 });

export default mongoose.model('AutopayMandate', mandateSchema);
