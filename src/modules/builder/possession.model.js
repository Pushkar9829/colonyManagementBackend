import mongoose from 'mongoose';
import { POSSESSION_STATUS } from './builder.constants.js';

const { ObjectId } = mongoose.Schema.Types;

const checklistItemSchema = new mongoose.Schema({ item: { type: String, required: true, trim: true }, done: { type: Boolean, default: false }, note: { type: String, trim: true } });

const possessionSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    unit: { type: ObjectId, ref: 'Unit', required: true },
    buyerName: { type: String, required: true, trim: true },
    buyerPhone: { type: String, trim: true },
    buyerEmail: { type: String, trim: true, lowercase: true },
    date: { type: String, required: true }, // YYYY-MM-DD (IST)
    startTime: { type: String, required: true }, // HH:MM
    endTime: { type: String, required: true },
    status: { type: String, enum: POSSESSION_STATUS, default: 'scheduled' },
    checklist: { type: [checklistItemSchema], default: [] },
    notes: { type: String, trim: true },
    completedAt: Date,
    completedBy: { type: ObjectId, ref: 'User' },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
possessionSchema.index({ society: 1, date: 1, startTime: 1 });
possessionSchema.index({ society: 1, unit: 1 });
export default mongoose.model('Possession', possessionSchema);
