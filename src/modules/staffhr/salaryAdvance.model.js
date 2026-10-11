import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Salary advance recovered from payroll in monthly instalments (paise).
const salaryAdvanceSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    employee: { type: ObjectId, ref: 'Employee', required: true },
    amount: { type: Number, min: 1, required: true },
    installment: { type: Number, min: 1, required: true },
    recovered: { type: Number, min: 0, default: 0 },
    date: { type: String, required: true },
    reason: { type: String, trim: true },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    recoveries: { type: [new mongoose.Schema({ period: String, amount: Number, payslip: { type: ObjectId, ref: 'Payslip' } }, { _id: false })], default: [] },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
salaryAdvanceSchema.index({ society: 1, employee: 1, status: 1 });

export default mongoose.model('SalaryAdvance', salaryAdvanceSchema);
