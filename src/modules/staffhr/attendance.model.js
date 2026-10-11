import mongoose from 'mongoose';
import { attachmentSchema } from '../assets/facility.shared.js';

export const ATTENDANCE_STATUS = ['present', 'late', 'half_day', 'absent', 'on_leave', 'week_off', 'holiday'];
export const PUNCH_SOURCES = ['self', 'manual', 'device'];

const { ObjectId } = mongoose.Schema.Types;

const punchSchema = new mongoose.Schema(
  {
    at: Date,
    source: { type: String, enum: PUNCH_SOURCES },
    photo: { type: attachmentSchema, default: undefined },
    lat: Number,
    lng: Number,
    accuracy: Number,
    distanceM: Number, // from the society geofence centre
    device: { type: ObjectId, ref: 'DeviceKey' },
  },
  { _id: false },
);

// One row per employee per calendar day (IST).
const attendanceSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    employee: { type: ObjectId, ref: 'Employee', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    shift: { type: ObjectId, ref: 'StaffShift' },
    shiftStart: String,
    shiftEnd: String,
    status: { type: String, enum: ATTENDANCE_STATUS, required: true },
    checkIn: { type: punchSchema, default: undefined },
    checkOut: { type: punchSchema, default: undefined },
    lateMinutes: { type: Number, default: 0 },
    workedMinutes: Number,
    leave: { type: ObjectId, ref: 'LeaveRequest' },
    paidLeave: Boolean, // on_leave: false for unpaid leave (counts as loss of pay)
    leaveDays: Number, // on_leave: 1, or 0.5 for a half-day leave
    notes: { type: String, trim: true },
    markedBy: { type: ObjectId, ref: 'User' }, // manual entries
    autoMarked: { type: Boolean, default: false }, // set by the absence job
  },
  { timestamps: true },
);
attendanceSchema.index({ society: 1, employee: 1, date: 1 }, { unique: true });
attendanceSchema.index({ society: 1, date: 1, status: 1 });

export default mongoose.model('StaffAttendance', attendanceSchema);
