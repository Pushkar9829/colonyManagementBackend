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
    // Set once the resident has authorised the mandate; a 'pending' sign-up may not have one yet.
    tokenId: { type: String, required() { return this.status === 'active'; } },
    customerId: { type: String },
    // pending: sign-up started, or authorised and waiting for the bank (e-NACH takes a few days)
    status: { type: String, enum: ['pending', 'active', 'cancelled', 'failed'], default: 'active' },
    providerOrderId: String, // the authorisation order (sign-up)
    authPaymentId: String,
    authAmount: { type: Number, default: 0 }, // paise debited to authorise (UPI ₹1), credited as advance
    authorisedMax: Number, // paise; the bank will refuse debits above the limit the resident authorised
    confirmedAt: Date,
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
mandateSchema.index({ providerOrderId: 1 }, { partialFilterExpression: { providerOrderId: { $type: 'string' } } });
mandateSchema.index({ tokenId: 1 });

export default mongoose.model('AutopayMandate', mandateSchema);
