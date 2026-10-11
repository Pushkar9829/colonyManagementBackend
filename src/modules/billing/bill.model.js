import mongoose from 'mongoose';
import { BILL_STATUS } from '../../common/constants/index.js';

// A bill line. `account` is the chart code the accounts module credits (4000 maintenance income,
// 3100 sinking fund, 3200 repair fund, 2300 GST payable). `gstRate` is the GST percent charged on
// this line (0/absent = exempt); the tax itself is on separate 'gst' lines ("CGST 9%", "SGST 9%").
// (4900 other income for cheque-bounce charges.) `kind` says where the line came from: charge | non_occupancy | metered | bounce_charge | gst | opening.
const lineSchema = new mongoose.Schema(
  {
    head: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    account: { type: String },
    gstRate: { type: Number, min: 0 },
    kind: { type: String },
  },
  { _id: false },
);

// Meter readings a bill charged for (shown on the invoice; used to roll meters back if it is cancelled).
const meterLineSchema = new mongoose.Schema(
  {
    meter: { type: mongoose.Schema.Types.ObjectId, ref: 'Meter' },
    serial: String,
    type: String,
    from: Number,
    fromAt: Date,
    to: Number,
    toAt: Date,
    consumption: Number,
  },
  { _id: false },
);

// All amounts in integer paise.
//   amount = sum of lines; total = amount + lateFee - waived; balance = total - paid.
//   `paid` includes advance credit applied to the bill (`creditApplied` is that part), so every
//   existing balance calculation (total - paid) stays correct.
const billSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    period: { type: String, required: true }, // YYYY-MM, or 'OPENING' for an imported opening-balance bill
    kind: { type: String, enum: ['regular', 'opening'], default: 'regular' },
    billNumber: { type: String, required: true },
    lines: { type: [lineSchema], default: [] },
    amount: { type: Number, required: true, min: 0 }, // sum of lines
    lateFee: { type: Number, default: 0, min: 0 },
    lateFeeAt: Date,
    waived: { type: Number, default: 0, min: 0 }, // approved waivers
    total: { type: Number, required: true, min: 0 }, // amount + lateFee - waived
    paid: { type: Number, default: 0, min: 0 },
    creditApplied: { type: Number, default: 0, min: 0 },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: BILL_STATUS, default: 'unpaid' },
    meters: { type: [meterLineSchema], default: undefined },
    gstin: { type: String }, // snapshot: makes this bill a GST tax invoice
    notes: String,
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastReminderAt: Date,
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);
billSchema.virtual('balance').get(function balance() {
  return Math.max(0, this.total - this.paid);
});
billSchema.index({ society: 1, unit: 1, period: 1 }, { unique: true });
billSchema.index({ society: 1, status: 1, dueDate: 1 });
billSchema.index({ society: 1, billNumber: 1 }, { unique: true });

export default mongoose.model('Bill', billSchema);
