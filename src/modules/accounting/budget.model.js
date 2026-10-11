import mongoose from 'mongoose';

// Annual budget for one income/expense account in a financial year (April–March).
const budgetSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    fyStart: { type: Number, required: true }, // 2026 = FY 2026-27
    code: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 }, // paise
    notes: { type: String, trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
budgetSchema.index({ society: 1, fyStart: 1, code: 1 }, { unique: true });

export default mongoose.model('Budget', budgetSchema);
