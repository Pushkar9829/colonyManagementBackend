import mongoose from 'mongoose';
import { attachmentSchema } from './facility.shared.js';

export const ASSET_EVENT_TYPES = [
  'created', 'updated', 'status_changed', 'service', 'amc_renewed', 'amc_visit', 'ppm_completed', 'ppm_missed',
  'breakdown_reported', 'breakdown_resolved', 'work_order', 'note',
];

const { ObjectId } = mongoose.Schema.Types;

// Service-history timeline of an asset. Other facility modules append to it through assets.service.recordEvent.
const assetEventSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    asset: { type: ObjectId, ref: 'Asset', required: true },
    type: { type: String, enum: ASSET_EVENT_TYPES, required: true },
    title: { type: String, required: true, trim: true },
    notes: { type: String, trim: true },
    cost: { type: Number, min: 0 }, // paise
    date: String, // YYYY-MM-DD the work happened
    ref: { kind: String, id: ObjectId }, // linked task / breakdown / work order
    attachments: { type: [attachmentSchema], default: [] },
    by: { type: ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
assetEventSchema.index({ society: 1, asset: 1, createdAt: -1 });

export default mongoose.model('AssetEvent', assetEventSchema);
