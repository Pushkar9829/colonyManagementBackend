import mongoose from 'mongoose';
import { attachmentSchema } from '../assets/facility.shared.js';
import { ASSIGNEE_ROLES, CHECK_TYPES } from './ppmSchedule.model.js';

export const TASK_STATUS = ['pending', 'overdue', 'completed', 'missed', 'skipped'];

const { ObjectId } = mongoose.Schema.Types;

const resultSchema = new mongoose.Schema(
  {
    itemId: ObjectId,
    label: String,
    type: { type: String, enum: CHECK_TYPES },
    unit: String,
    min: Number,
    max: Number,
    value: mongoose.Schema.Types.Mixed, // boolean | number | string
    ok: { type: Boolean, default: true }, // false when "no" or a reading is out of range
  },
  { _id: false },
);

// One occurrence of a PPM schedule. Unique per (schedule, dueDate) so the generator is idempotent.
const ppmTaskSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    schedule: { type: ObjectId, ref: 'PpmSchedule', required: true },
    asset: { type: ObjectId, ref: 'Asset', required: true },
    title: { type: String, required: true },
    dueDate: { type: String, required: true }, // YYYY-MM-DD
    missAfter: { type: String, required: true }, // dueDate + graceDays
    status: { type: String, enum: TASK_STATUS, default: 'pending' },
    assigneeRole: { type: String, enum: ASSIGNEE_ROLES },
    assignee: { type: ObjectId, ref: 'User' },
    results: { type: [resultSchema], default: [] },
    photos: { type: [attachmentSchema], default: [] },
    remarks: { type: String, trim: true },
    hasIssues: { type: Boolean, default: false },
    late: { type: Boolean, default: false },
    completedBy: { type: ObjectId, ref: 'User' },
    completedAt: Date,
    skipReason: { type: String, trim: true },
    overdueNotifiedAt: Date,
    breakdown: { type: ObjectId, ref: 'AssetBreakdown' },
  },
  { timestamps: true },
);
ppmTaskSchema.index({ schedule: 1, dueDate: 1 }, { unique: true });
ppmTaskSchema.index({ society: 1, status: 1, dueDate: 1 });
ppmTaskSchema.index({ society: 1, assignee: 1, dueDate: 1 });
ppmTaskSchema.index({ society: 1, asset: 1, dueDate: -1 });

export default mongoose.model('PpmTask', ppmTaskSchema);
