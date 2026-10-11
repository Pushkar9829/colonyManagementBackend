import mongoose from 'mongoose';

const lineSchema = new mongoose.Schema(
  { description: { type: String, required: true, trim: true }, account: { type: String, required: true }, amount: { type: Number, required: true, min: 1 } },
  { _id: false },
);

// Template that raises the same vendor bill every month (e.g. security agency, lift AMC).
const recurringExpenseSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    lines: { type: [lineSchema], validate: [(v) => v.length > 0, 'At least one line is required'] },
    gstAmount: { type: Number, default: 0, min: 0 },
    claimGst: { type: Boolean, default: false },
    tdsRate: { type: Number, min: 0, max: 30 }, // empty: use the vendor's rate
    dayOfMonth: { type: Number, required: true, min: 1, max: 28 },
    dueDays: { type: Number, default: 15, min: 0, max: 120 },
    startDate: { type: String, required: true }, // YYYY-MM-DD
    endDate: { type: String },
    active: { type: Boolean, default: true },
    lastPeriod: { type: String }, // YYYY-MM of the last generated bill
    lastBill: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorBill' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
recurringExpenseSchema.index({ society: 1, active: 1, dayOfMonth: 1 });

export default mongoose.model('RecurringExpense', recurringExpenseSchema);
