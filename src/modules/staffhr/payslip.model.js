import mongoose from 'mongoose';

export const PAYSLIP_STATUS = ['draft', 'approved', 'paid'];
export const PAY_METHODS = ['bank', 'upi', 'cash', 'cheque'];

const { ObjectId } = mongoose.Schema.Types;
const lineSchema = new mongoose.Schema({ head: { type: String, required: true }, amount: { type: Number, required: true } }, { _id: false });

// CONTRACT with the accounting module — keep these fields and meanings stable:
//   society, employee, user, period 'YYYY-MM', gross, deductions, net (all paise),
//   status 'draft' | 'approved' | 'paid', paidAt, method, reference.
// Everything else is payroll detail owned by staffhr.
const payslipSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    employee: { type: ObjectId, ref: 'Employee', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    period: { type: String, required: true },
    gross: { type: Number, required: true, min: 0 },
    deductions: { type: Number, required: true, min: 0 },
    net: { type: Number, required: true },
    status: { type: String, enum: PAYSLIP_STATUS, default: 'draft' },
    paidAt: Date,
    method: { type: String, enum: PAY_METHODS },
    reference: { type: String, trim: true },

    run: { type: ObjectId, ref: 'PayrollRun', required: true },
    number: String, // PS-2026-10-0001
    employeeCode: String,
    name: String,
    designation: String,
    department: String,
    bankLast4: String,
    daysInPeriod: Number,
    paidDays: Number,
    lopDays: Number,
    attendance: { present: Number, late: Number, halfDay: Number, absent: Number, paidLeave: Number, unpaidLeave: Number, weekOff: Number, unmarked: Number },
    earnings: { type: [lineSchema], default: [] },
    deductionLines: { type: [lineSchema], default: [] },
    adjustments: { type: [new mongoose.Schema({ head: String, amount: Number, kind: { type: String, enum: ['earning', 'deduction'] } }, { _id: false })], default: [] },
    advanceRecoveries: { type: [new mongoose.Schema({ advance: { type: ObjectId, ref: 'SalaryAdvance' }, amount: Number }, { _id: false })], default: [] },
    paidBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
payslipSchema.index({ society: 1, period: 1, employee: 1 }, { unique: true });
payslipSchema.index({ society: 1, user: 1, period: -1 });
payslipSchema.index({ society: 1, run: 1 });

export default mongoose.model('Payslip', payslipSchema);
