import mongoose from 'mongoose';
import { attachmentSchema } from '../assets/facility.shared.js';
import { ASSIGNEE_ROLES } from './ppmSchedule.model.js';

export const RUN_STATUS = ['pending', 'completed', 'verified', 'rejected', 'missed'];

const { ObjectId } = mongoose.Schema.Types;

// One checklist slot on one day, e.g. "Lobby cleaning · Morning · 2026-10-11".
const checklistRunSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    checklist: { type: ObjectId, ref: 'HousekeepingChecklist', required: true },
    name: String,
    area: String,
    date: { type: String, required: true },
    slot: { type: String, required: true },
    dueAt: { type: Date, required: true },
    missAt: { type: Date, required: true },
    assigneeRole: { type: String, enum: ASSIGNEE_ROLES },
    assignee: { type: ObjectId, ref: 'User' },
    status: { type: String, enum: RUN_STATUS, default: 'pending' },
    items: { type: [new mongoose.Schema({ itemId: ObjectId, label: String, done: Boolean, note: String }, { _id: false })], default: [] },
    photos: { type: [attachmentSchema], default: [] },
    remarks: { type: String, trim: true },
    completedBy: { type: ObjectId, ref: 'User' },
    completedAt: Date,
    verifiedBy: { type: ObjectId, ref: 'User' },
    verifiedAt: Date,
    verifyNote: { type: String, trim: true },
  },
  { timestamps: true },
);
checklistRunSchema.index({ checklist: 1, date: 1, slot: 1 }, { unique: true });
checklistRunSchema.index({ society: 1, date: 1, status: 1 });
checklistRunSchema.index({ society: 1, status: 1, missAt: 1 });

export default mongoose.model('HousekeepingRun', checklistRunSchema);
