import mongoose from 'mongoose';

// Chart-of-accounts codes used on bill lines (read by the accounts module when it posts journals).
export const ACCOUNTS = Object.freeze({
  MAINTENANCE: '4000', // maintenance income (default for every charge head)
  SINKING_FUND: '3100',
  REPAIR_FUND: '3200',
  GST_PAYABLE: '2300', // output CGST/SGST
  OTHER_INCOME: '4900', // cheque bounce charges
});

// Used until a society saves its own mapping, so fund heads never land in income by accident.
export const DEFAULT_HEAD_ACCOUNTS = [
  { head: 'Sinking fund', account: ACCOUNTS.SINKING_FUND },
  { head: 'Repair fund', account: ACCOUNTS.REPAIR_FUND },
];

const headAccountSchema = new mongoose.Schema(
  { head: { type: String, required: true, trim: true }, account: { type: String, required: true, trim: true } },
  { _id: false },
);
const headGstSchema = new mongoose.Schema(
  { head: { type: String, required: true, trim: true }, rate: { type: Number, required: true, min: 0, max: 28 } },
  { _id: false },
);

// One document per society. Kept out of Society.settings so finance rules evolve without touching the core model.
const financeSettingsSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true, unique: true },
    gstin: { type: String, trim: true, uppercase: true },
    gstEnabled: { type: Boolean, default: false },
    gstDefaultRate: { type: Number, default: 18, min: 0, max: 28 }, // percent, split equally into CGST + SGST
    // Housing societies pay GST only when a member's monthly charges exceed a limit (₹7,500 today). 0 = always.
    gstExemptUpTo: { type: Number, default: 0, min: 0 }, // paise
    headGst: { type: [headGstSchema], default: [] }, // per charge head override, e.g. Water → 0
    headAccounts: { type: [headAccountSchema], default: () => DEFAULT_HEAD_ACCOUNTS.map((h) => ({ ...h })) },
    nonOccupancy: {
      percent: { type: Number, default: 0, min: 0, max: 100 }, // of the maintenance (service) charges
      appliesTo: { type: [{ type: String, enum: ['rented', 'vacant'] }], default: ['rented'] },
    },
    chequeBounceCharge: { type: Number, default: 0, min: 0 }, // paise
    waiverApprovalRequired: { type: Boolean, default: true },
    restrictAmenityForDefaulters: { type: Boolean, default: false },
    autopayEnabled: { type: Boolean, default: false },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export default mongoose.model('FinanceSettings', financeSettingsSchema);
