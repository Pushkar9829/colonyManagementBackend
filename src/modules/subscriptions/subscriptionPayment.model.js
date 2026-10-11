import mongoose from 'mongoose';

// A payment of a platform invoice (online via the payment provider, or recorded by the platform team).
const subscriptionPaymentSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformInvoice', required: true },
    amount: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ['online', 'bank', 'upi', 'cheque', 'cash'], required: true },
    reference: { type: String, trim: true },
    provider: String,
    providerOrderId: String,
    providerPaymentId: String,
    status: { type: String, enum: ['created', 'success', 'failed'], default: 'created' },
    paidAt: Date,
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: String,
  },
  { timestamps: true },
);
subscriptionPaymentSchema.index({ society: 1, createdAt: -1 });
subscriptionPaymentSchema.index({ invoice: 1 });
subscriptionPaymentSchema.index({ providerOrderId: 1 }, { unique: true, partialFilterExpression: { providerOrderId: { $type: 'string' } } });

export default mongoose.model('SubscriptionPayment', subscriptionPaymentSchema);
