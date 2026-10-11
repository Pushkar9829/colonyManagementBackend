import mongoose from 'mongoose';
import { attachmentSchema } from '../assets/facility.shared.js';

export const WO_STATUS = ['open', 'in_progress', 'completed', 'verified', 'cancelled'];
export const WO_SOURCES = ['asset', 'ppm', 'breakdown', 'adhoc'];

const { ObjectId } = mongoose.Schema.Types;

const historySchema = new mongoose.Schema(
  { by: { type: ObjectId, ref: 'User' }, from: String, to: String, note: String },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } },
);

// Job given to an outside vendor or an in-house technician. The vendor is owned by another module:
// keep its id (never populated as a hard dependency) plus a readable name.
const workOrderSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true }, // WO-000001
    title: { type: String, required: true, trim: true },
    scope: { type: String, trim: true },
    source: { type: String, enum: WO_SOURCES, default: 'adhoc' },
    asset: { type: ObjectId, ref: 'Asset' },
    ppmTask: { type: ObjectId, ref: 'PpmTask' },
    breakdown: { type: ObjectId, ref: 'AssetBreakdown' },
    location: { type: String, trim: true },
    vendor: { type: ObjectId, ref: 'Vendor' },
    vendorName: { type: String, trim: true },
    technician: { type: ObjectId, ref: 'User' },
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    estimate: { type: Number, min: 0, default: 0 }, // paise
    actualCost: { type: Number, min: 0 },
    dueDate: String,
    status: { type: String, enum: WO_STATUS, default: 'open' },
    attachments: { type: [attachmentSchema], default: [] },
    completion: {
      notes: { type: String, trim: true },
      attachments: { type: [attachmentSchema], default: [] },
      completedAt: Date,
      completedBy: { type: ObjectId, ref: 'User' },
    },
    verifiedBy: { type: ObjectId, ref: 'User' },
    verifiedAt: Date,
    history: { type: [historySchema], default: [] },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
workOrderSchema.index({ society: 1, number: 1 }, { unique: true });
workOrderSchema.index({ society: 1, status: 1, createdAt: -1 });
workOrderSchema.index({ society: 1, technician: 1, status: 1 });
workOrderSchema.index({ society: 1, asset: 1 });

export default mongoose.model('WorkOrder', workOrderSchema);
