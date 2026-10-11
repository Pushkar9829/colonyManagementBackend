import mongoose from 'mongoose';
import { attachmentSchema } from '../assets/facility.shared.js';

export const BREAKDOWN_STATUS = ['open', 'in_progress', 'resolved', 'closed'];
export const BREAKDOWN_PRIORITY = ['low', 'medium', 'high', 'urgent'];

const { ObjectId } = mongoose.Schema.Types;

// Equipment failure ticket. Can point at the helpdesk complaint that reported it.
const breakdownSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true }, // BRK-000001
    asset: { type: ObjectId, ref: 'Asset', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    priority: { type: String, enum: BREAKDOWN_PRIORITY, default: 'high' },
    status: { type: String, enum: BREAKDOWN_STATUS, default: 'open' },
    complaint: { type: ObjectId, ref: 'Complaint' },
    ppmTask: { type: ObjectId, ref: 'PpmTask' },
    workOrder: { type: ObjectId, ref: 'WorkOrder' },
    reportedBy: { type: ObjectId, ref: 'User' },
    assignedTo: { type: ObjectId, ref: 'User' },
    attachments: { type: [attachmentSchema], default: [] },
    resolution: { type: String, trim: true },
    cost: { type: Number, min: 0 }, // paise
    resolvedAt: Date,
    resolvedBy: { type: ObjectId, ref: 'User' },
    closedAt: Date,
  },
  { timestamps: true },
);
breakdownSchema.index({ society: 1, number: 1 }, { unique: true });
breakdownSchema.index({ society: 1, status: 1, createdAt: -1 });
breakdownSchema.index({ society: 1, asset: 1, createdAt: -1 });

export default mongoose.model('AssetBreakdown', breakdownSchema);
