import mongoose from 'mongoose';

// Per-society expense rules. Purchase requests at or below autoApproveLimit skip admin approval (0 = never).
const expenseSettingsSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true, unique: true },
    autoApproveLimit: { type: Number, default: 0, min: 0 }, // paise
    defaultDueDays: { type: Number, default: 15, min: 0, max: 180 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export default mongoose.model('ExpenseSettings', expenseSettingsSchema);
