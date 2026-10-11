import mongoose from 'mongoose';
import { ASSIGNEE_ROLES } from './ppmSchedule.model.js';

export const CHECKLIST_AREAS = ['lobby', 'lift', 'garbage_room', 'gym', 'corridor', 'staircase', 'parking', 'pool', 'garden', 'terrace', 'clubhouse', 'washroom', 'other'];

const { ObjectId } = mongoose.Schema.Types;

// A housekeeping / area checklist template with the shift slots it must be done in.
const checklistSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    area: { type: String, enum: CHECKLIST_AREAS, default: 'other' },
    location: { type: String, trim: true },
    items: { type: [new mongoose.Schema({ label: { type: String, required: true, trim: true } })], default: [] },
    // e.g. [{ label: 'Morning', dueBy: '10:00' }, { label: 'Evening', dueBy: '18:00' }]
    slots: { type: [new mongoose.Schema({ label: { type: String, required: true, trim: true }, dueBy: { type: String, required: true } }, { _id: false })], default: [] },
    days: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] }, // weekdays, 0 = Sunday
    assigneeRole: { type: String, enum: ASSIGNEE_ROLES, default: 'staff' },
    assignee: { type: ObjectId, ref: 'User' },
    requirePhoto: { type: Boolean, default: true },
    graceMinutes: { type: Number, min: 0, max: 720, default: 120 }, // after dueBy → missed
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
checklistSchema.index({ society: 1, active: 1 });

export default mongoose.model('HousekeepingChecklist', checklistSchema);
