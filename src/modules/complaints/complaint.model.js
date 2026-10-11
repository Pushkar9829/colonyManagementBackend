import mongoose from 'mongoose';
import { COMPLAINT_PRIORITY, COMPLAINT_STATUS } from '../../common/constants/index.js';

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

const commentSchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true },
    internal: { type: Boolean, default: false }, // visible to staff only
    attachments: { type: [attachmentSchema], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const historySchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    from: String,
    to: String,
    note: String,
    kind: { type: String, enum: ['status', 'escalation'], default: 'status' },
    level: Number, // escalation level, for kind 'escalation'
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } },
);

const complaintSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    ticketNumber: { type: String, required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // a default category (COMPLAINT_CATEGORIES) or a society's custom one (ComplaintCategory.key)
    category: { type: String, required: true, lowercase: true, trim: true },
    priority: { type: String, enum: COMPLAINT_PRIORITY, default: 'medium' },
    area: { type: String, enum: ['unit', 'common'], default: 'unit' },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    attachments: { type: [attachmentSchema], default: [] },
    status: { type: String, enum: COMPLAINT_STATUS, default: 'open' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    slaDueAt: Date,
    slaEscalatedAt: Date,
    escalationLevel: { type: Number, default: 0, min: 0, max: 3 },
    escalations: {
      type: [
        new mongoose.Schema(
          { level: Number, at: Date, notified: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], hoursOverdue: Number },
          { _id: false },
        ),
      ],
      default: [],
    },
    // proof of work for categories that require it (set when moving to resolved)
    resolutionPhotos: {
      before: { type: [attachmentSchema], default: [] },
      after: { type: [attachmentSchema], default: [] },
    },
    resolvedAt: Date,
    closedAt: Date,
    comments: { type: [commentSchema], default: [] },
    history: { type: [historySchema], default: [] },
    rating: { type: Number, min: 1, max: 5 },
    feedback: { type: String, trim: true },
  },
  { timestamps: true },
);
complaintSchema.index({ society: 1, ticketNumber: 1 }, { unique: true });
complaintSchema.index({ society: 1, status: 1, createdAt: -1 });
complaintSchema.index({ society: 1, raisedBy: 1, createdAt: -1 });
complaintSchema.index({ society: 1, assignedTo: 1, status: 1 });
complaintSchema.index({ status: 1, slaDueAt: 1, escalationLevel: 1 });

export default mongoose.model('Complaint', complaintSchema);
