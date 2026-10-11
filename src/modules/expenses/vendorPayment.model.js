import mongoose from 'mongoose';
import { VENDOR_PAYMENT_METHODS } from './constants.js';

const allocationSchema = new mongoose.Schema(
  { bill: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorBill', required: true }, amount: { type: Number, required: true, min: 1 } },
  { _id: false },
);

const vendorPaymentSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true }, // VP-000001
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    amount: { type: Number, required: true, min: 1 }, // paise
    method: { type: String, enum: VENDOR_PAYMENT_METHODS, required: true },
    reference: { type: String, trim: true }, // UTR / cheque no.
    account: { type: String, required: true }, // bank or cash account code paid from
    allocations: { type: [allocationSchema], validate: [(v) => v.length > 0, 'Allocate the payment to at least one bill'] },
    notes: { type: String, trim: true },
    status: { type: String, enum: ['posted', 'cancelled'], default: 'posted' },
    cancelledAt: Date,
    cancelReason: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
vendorPaymentSchema.index({ society: 1, number: 1 }, { unique: true });
vendorPaymentSchema.index({ society: 1, vendor: 1, date: -1 });
vendorPaymentSchema.index({ society: 1, 'allocations.bill': 1 });

export default mongoose.model('VendorPayment', vendorPaymentSchema);
