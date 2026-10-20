import mongoose from 'mongoose';
import { BILLING_CYCLES } from '../subscriptions/subscriptions.constants.js';

// Platform invoice to a reseller for a pack of licence keys. Numbered from the same PINV- series as
// society invoices; kept apart because a key pack has no society, period or units.
const resellerInvoiceSchema = new mongoose.Schema(
  {
    reseller: { type: mongoose.Schema.Types.ObjectId, ref: 'Reseller', required: true },
    number: { type: String, required: true, unique: true },
    batch: { type: String, required: true },
    keys: { type: Number, required: true, min: 1 },
    plan: { type: String, required: true },
    cycle: { type: String, enum: BILLING_CYCLES, required: true },
    validityMonths: { type: Number, default: null },
    pricePerKey: { type: Number, required: true, min: 0 }, // paise
    subtotal: { type: Number, required: true, min: 0 },
    gstRate: { type: Number, required: true },
    gst: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['unpaid', 'paid', 'void'], default: 'unpaid' },
    paidAt: Date,
    method: { type: String, enum: ['bank', 'upi', 'cheque', 'cash'] },
    reference: { type: String, trim: true },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
resellerInvoiceSchema.index({ reseller: 1, createdAt: -1 });

export default mongoose.model('ResellerInvoice', resellerInvoiceSchema);
