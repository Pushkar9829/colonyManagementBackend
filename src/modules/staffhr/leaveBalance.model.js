import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Per-employee yearly allocation overrides (otherwise the society quota applies) and carried-forward EL.
const leaveBalanceSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    employee: { type: ObjectId, ref: 'Employee', required: true },
    year: { type: Number, required: true },
    allocations: { casual: Number, sick: Number, earned: Number },
    carriedForward: { type: Number, min: 0, default: 0 }, // extra earned leave from last year
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
leaveBalanceSchema.index({ society: 1, employee: 1, year: 1 }, { unique: true });

export default mongoose.model('LeaveBalance', leaveBalanceSchema);
