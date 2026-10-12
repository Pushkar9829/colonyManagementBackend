import mongoose from 'mongoose';
import { PAYMENT_METHODS } from '../../common/constants/index.js';

// 'autopay' = charged through a recurring mandate (UPI AutoPay / e-NACH).
export const METHODS = [...PAYMENT_METHODS, 'autopay'];
export const PAYMENT_STATUS = ['created', 'success', 'failed', 'bounced'];

// `amount` is the money received. `appliedAmount` of it went to `bill`; the rest (`advanceAmount`) is
// held as advance credit through an 'advance' Adjustment. Advance-only payments have no bill.
const paymentSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    bill: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill' },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    purpose: { type: String, enum: ['bill', 'advance'], default: 'bill' },
    amount: { type: Number, required: true, min: 1 }, // paise
    appliedAmount: { type: Number, min: 0 },
    advanceAmount: { type: Number, default: 0, min: 0 },
    method: { type: String, enum: METHODS, required: true },
    reference: { type: String, trim: true }, // cheque no / UTR
    provider: { type: String }, // mock | razorpay (online only)
    providerOrderId: { type: String },
    providerPaymentId: { type: String },
    mandate: { type: mongoose.Schema.Types.ObjectId, ref: 'AutopayMandate' },
    status: { type: String, enum: PAYMENT_STATUS, default: 'success' },
    receiptNumber: { type: String },
    paidAt: Date,
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    bouncedAt: Date,
    bounceReason: { type: String, trim: true },
    bouncedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: String,
    settling: Boolean, // claimed by settlePayment, so a client retry and a webhook can't both apply it
  },
  { timestamps: true },
);
paymentSchema.index({ society: 1, bill: 1 });
paymentSchema.index({ society: 1, unit: 1, paidAt: 1 });
paymentSchema.index({ society: 1, status: 1, paidAt: -1 });
paymentSchema.index({ providerOrderId: 1 }, { unique: true, partialFilterExpression: { providerOrderId: { $type: 'string' } } });
paymentSchema.index({ society: 1, receiptNumber: 1 }, { unique: true, partialFilterExpression: { receiptNumber: { $type: 'string' } } });

export default mongoose.model('Payment', paymentSchema);
