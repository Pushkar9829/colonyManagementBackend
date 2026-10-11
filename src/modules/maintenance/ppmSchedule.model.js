import mongoose from 'mongoose';

export const PPM_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'every_n_days'];
export const CHECK_TYPES = ['yes_no', 'reading', 'text'];
export const ASSIGNEE_ROLES = ['staff', 'facility_manager', 'guard'];

const { ObjectId } = mongoose.Schema.Types;

const checkItemSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true },
  type: { type: String, enum: CHECK_TYPES, default: 'yes_no' },
  unit: { type: String, trim: true }, // for readings: "bar", "°C", "V"
  min: Number, // acceptable range for readings
  max: Number,
  required: { type: Boolean, default: true },
});

// A preventive-maintenance plan for one asset. The scheduler turns it into PpmTask occurrences ahead of time.
const ppmScheduleSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    asset: { type: ObjectId, ref: 'Asset', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    frequency: { type: String, enum: PPM_FREQUENCIES, required: true },
    intervalDays: { type: Number, min: 1, max: 3650 }, // for every_n_days
    startDate: { type: String, required: true }, // first occurrence, YYYY-MM-DD
    endDate: String,
    checklist: { type: [checkItemSchema], default: [] },
    assigneeRole: { type: String, enum: ASSIGNEE_ROLES, default: 'staff' },
    assignee: { type: ObjectId, ref: 'User' }, // a specific person; otherwise anyone with assigneeRole
    leadDays: { type: Number, min: 0, max: 60, default: 7 }, // how far ahead tasks are created
    graceDays: { type: Number, min: 0, max: 60, default: 3 }, // overdue for this long → missed
    active: { type: Boolean, default: true },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
ppmScheduleSchema.index({ society: 1, asset: 1 });
ppmScheduleSchema.index({ society: 1, active: 1 });

export default mongoose.model('PpmSchedule', ppmScheduleSchema);
