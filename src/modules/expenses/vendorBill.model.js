import mongoose from 'mongoose';
import { VENDOR_BILL_STATUS } from './constants.js';

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });
const lineSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true },
    account: { type: String, required: true }, // expense account code
    amount: { type: Number, required: true, min: 1 }, // paise
  },
  { _id: false },
);

// A supplier invoice. payable = total - TDS (the TDS is withheld and owed to the government instead).
const vendorBillSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true }, // VB-000001 (ours)
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    billNo: { type: String, required: true, trim: true }, // the vendor's invoice number
    billDate: { type: String, required: true }, // YYYY-MM-DD
    dueDate: { type: String, required: true },
    lines: { type: [lineSchema], validate: [(v) => v.length > 0, 'At least one line is required'] },
    subtotal: { type: Number, required: true, min: 0 },
    gstAmount: { type: Number, default: 0, min: 0 },
    claimGst: { type: Boolean, default: false }, // true: GST is input credit (1150); false: part of the expense
    tdsSection: { type: String },
    tdsRate: { type: Number, default: 0, min: 0, max: 30 },
    tdsAmount: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 }, // subtotal + GST
    payable: { type: Number, required: true, min: 0 }, // total - TDS
    paid: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: VENDOR_BILL_STATUS, default: 'unpaid' },
    attachments: { type: [attachmentSchema], default: [] },
    purchaseRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseRequest' },
    recurring: { type: mongoose.Schema.Types.ObjectId, ref: 'RecurringExpense' },
    recurringPeriod: { type: String }, // YYYY-MM: one bill per template per month
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelledAt: Date,
    cancelReason: { type: String, trim: true },
    dueReminderAt: Date,
  },
  { timestamps: true },
);
vendorBillSchema.index({ society: 1, number: 1 }, { unique: true });
vendorBillSchema.index({ society: 1, vendor: 1, billNo: 1 }, { unique: true });
vendorBillSchema.index({ society: 1, status: 1, dueDate: 1 });
vendorBillSchema.index({ society: 1, billDate: -1 });
vendorBillSchema.index(
  { society: 1, recurring: 1, recurringPeriod: 1 },
  { unique: true, partialFilterExpression: { recurringPeriod: { $type: 'string' } } },
);

export const billBalance = (b) => (b.status === 'cancelled' ? 0 : Math.max(0, b.payable - b.paid));

export default mongoose.model('VendorBill', vendorBillSchema);
