import mongoose from 'mongoose';

export const LEAVE_TYPES = ['casual', 'sick', 'earned', 'unpaid'];
export const PAID_LEAVE_TYPES = ['casual', 'sick', 'earned'];
export const LEAVE_STATUS = ['pending', 'approved', 'rejected', 'cancelled'];

const { ObjectId } = mongoose.Schema.Types;

const leaveRequestSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    employee: { type: ObjectId, ref: 'Employee', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, enum: LEAVE_TYPES, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    halfDay: { type: Boolean, default: false }, // only when from === to
    days: { type: Number, required: true },
    year: { type: Number, required: true },
    reason: { type: String, trim: true },
    status: { type: String, enum: LEAVE_STATUS, default: 'pending' },
    decidedBy: { type: ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionNote: { type: String, trim: true },
  },
  { timestamps: true },
);
leaveRequestSchema.index({ society: 1, employee: 1, year: 1, status: 1 });
leaveRequestSchema.index({ society: 1, status: 1, from: 1 });

export default mongoose.model('LeaveRequest', leaveRequestSchema);
