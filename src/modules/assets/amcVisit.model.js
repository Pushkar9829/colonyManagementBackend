import mongoose from 'mongoose';
import { attachmentSchema } from './facility.shared.js';

const { ObjectId } = mongoose.Schema.Types;

// A visit by the AMC vendor, logged against the contract active at the time.
const amcVisitSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    asset: { type: ObjectId, ref: 'Asset', required: true },
    contractNumber: { type: String, trim: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    type: { type: String, enum: ['preventive', 'breakdown', 'inspection'], default: 'preventive' },
    technician: { type: String, trim: true },
    findings: { type: String, trim: true },
    attachments: { type: [attachmentSchema], default: [] },
    by: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
amcVisitSchema.index({ society: 1, asset: 1, date: -1 });

export default mongoose.model('AmcVisit', amcVisitSchema);
