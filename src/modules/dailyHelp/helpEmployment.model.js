import mongoose from 'mongoose';

// A household's private arrangement with a helper (salary and pay day). Only that unit sees it.
const helpEmploymentSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    help: { type: mongoose.Schema.Types.ObjectId, ref: 'DailyHelp', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    salary: { type: Number, min: 0, default: 0 }, // paise per month
    dueDay: { type: Number, min: 1, max: 28, default: 1 }, // day of month the salary is due
    remindersOn: { type: Boolean, default: true },
    lastRemindedPeriod: String, // YYYY-MM
    lastPaidPeriod: String, // YYYY-MM
    lastPaidAt: Date,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
helpEmploymentSchema.index({ society: 1, help: 1, unit: 1 }, { unique: true });
helpEmploymentSchema.index({ remindersOn: 1, dueDay: 1 });

export default mongoose.model('HelpEmployment', helpEmploymentSchema);
