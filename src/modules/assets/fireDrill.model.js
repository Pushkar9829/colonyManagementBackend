import mongoose from 'mongoose';
import { attachmentSchema } from './facility.shared.js';

const { ObjectId } = mongoose.Schema.Types;

const fireDrillSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    date: { type: String, required: true },
    time: String, // HH:MM
    scenario: { type: String, trim: true },
    conductedBy: { type: String, trim: true },
    attendance: { type: Number, min: 0, default: 0 },
    evacuationMinutes: { type: Number, min: 0 },
    notes: { type: String, trim: true },
    attachments: { type: [attachmentSchema], default: [] },
    by: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
fireDrillSchema.index({ society: 1, date: -1 });

export default mongoose.model('FireDrill', fireDrillSchema);
