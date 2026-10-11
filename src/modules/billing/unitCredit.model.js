import mongoose from 'mongoose';

// Running advance/credit balance per unit (paise). It is a cache of the approved
// advance + credit − credit_applied − refund adjustments, kept so spending credit can be a single
// conditional update ({ balance: { $gte: x } }) and never goes negative under concurrent requests.
const unitCreditSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    balance: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);
unitCreditSchema.index({ society: 1, unit: 1 }, { unique: true });
unitCreditSchema.index({ society: 1, balance: -1 });

export default mongoose.model('UnitCredit', unitCreditSchema);
