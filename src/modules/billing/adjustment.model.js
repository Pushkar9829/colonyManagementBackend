import mongoose from 'mongoose';

export const ADJUSTMENT_TYPES = ['waiver', 'credit', 'credit_applied', 'refund', 'bounce_charge', 'opening_balance', 'advance'];
export const ADJUSTMENT_STATUS = ['pending', 'approved', 'rejected'];
// Types that add to / take from a unit's advance credit (see unitCredit.model.js).
export const CREDIT_IN = ['advance', 'credit'];
export const CREDIT_OUT = ['credit_applied', 'refund'];

// Every non-cash change to what a household owes. Amounts are positive paise; the type gives the direction.
// Only waivers start 'pending' (maker-checker); everything else is created 'approved'.
//
// How each type should be read (accounts module):
//   waiver          bill set. Reduces the bill total (Bill.waived). Dr waiver/expense, Cr receivable.
//   credit          credit note to the unit's advance balance, no cash. Dr expense, Cr advances.
//   advance         money held for the unit. With `payment` set it is the advance part of that payment
//                   (the cash itself is the Payment — do not post the cash twice); without `payment` it
//                   is an opening advance from the import. Cr advances.
//   credit_applied  bill set. Advance used to pay a bill (Bill.creditApplied/paid). Dr advances, Cr receivable.
//   refund          advance paid back (method/reference). Dr advances, Cr bank.
//   bounce_charge   cheque-bounce fee. Informational: the income is posted through the bill line of
//                   kind 'bounce_charge' on the bill named in `bill` (set once it has been billed).
//   opening_balance dues brought forward at go-live. Dr receivable, Cr opening balances. The matching
//                   Bill has kind 'opening' and must not be posted as income.
// A bounced payment's advance part is reversed by setting its 'advance' adjustment to 'rejected'.
const adjustmentSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    number: { type: String }, // ADJ-000001
    bill: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill' },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    type: { type: String, enum: ADJUSTMENT_TYPES, required: true },
    amount: { type: Number, required: true, min: 1 },
    reason: { type: String, trim: true, maxlength: 300 },
    status: { type: String, enum: ADJUSTMENT_STATUS, default: 'approved' },
    method: { type: String }, // refunds: cash | cheque | upi | bank
    reference: { type: String, trim: true }, // refunds: UTR / cheque no.
    effectiveDate: { type: Date }, // opening balances: the as-of date
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    decisionNote: { type: String, trim: true },
  },
  { timestamps: true },
);
adjustmentSchema.index({ society: 1, unit: 1, createdAt: 1 });
adjustmentSchema.index({ society: 1, type: 1, status: 1, createdAt: -1 });
adjustmentSchema.index({ society: 1, bill: 1 });
adjustmentSchema.index({ society: 1, number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });

export default mongoose.model('Adjustment', adjustmentSchema);
