import mongoose from 'mongoose';

export const RUN_STATUS = ['draft', 'approved', 'paid'];

const { ObjectId } = mongoose.Schema.Types;

// One payroll per society per month. Payslips carry the detail; totals are kept in sync for lists.
const payrollRunSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    period: { type: String, required: true }, // YYYY-MM
    status: { type: String, enum: RUN_STATUS, default: 'draft' },
    employees: { type: Number, default: 0 },
    gross: { type: Number, default: 0 },
    deductions: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
    paidCount: { type: Number, default: 0 },
    createdBy: { type: ObjectId, ref: 'User' },
    approvedBy: { type: ObjectId, ref: 'User' },
    approvedAt: Date,
  },
  { timestamps: true },
);
payrollRunSchema.index({ society: 1, period: 1 }, { unique: true });

export default mongoose.model('PayrollRun', payrollRunSchema);
