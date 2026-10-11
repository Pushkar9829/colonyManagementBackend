import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// One employee's shifts for one week (Monday first). A null entry is a day off.
const rosterWeekSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    employee: { type: ObjectId, ref: 'Employee', required: true },
    weekStart: { type: String, required: true }, // Monday, YYYY-MM-DD
    shifts: { type: [{ type: ObjectId, ref: 'StaffShift', default: null }], validate: (v) => v.length === 7 },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
rosterWeekSchema.index({ society: 1, weekStart: 1, employee: 1 }, { unique: true });

export default mongoose.model('RosterWeek', rosterWeekSchema);
