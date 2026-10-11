import mongoose from 'mongoose';
import { SNAG_CATEGORIES, SNAG_STATUS } from './builder.constants.js';

const { ObjectId } = mongoose.Schema.Types;
const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

const snagHistorySchema = new mongoose.Schema({ by: { type: ObjectId, ref: 'User' }, from: String, to: String, note: String }, { _id: false, timestamps: { createdAt: true, updatedAt: false } });

const snagSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    unit: { type: ObjectId, ref: 'Unit', required: true },
    number: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String, enum: SNAG_CATEGORIES, default: 'other' },
    location: { type: String, trim: true }, // room / area, e.g. "Master bathroom"
    photos: { type: [attachmentSchema], default: [] },
    fixPhotos: { type: [attachmentSchema], default: [] },
    status: { type: String, enum: SNAG_STATUS, default: 'open' },
    contractor: { name: { type: String, trim: true }, phone: { type: String, trim: true } },
    targetDate: String, // YYYY-MM-DD
    raisedBy: { type: ObjectId, ref: 'User', required: true },
    fixedAt: Date,
    // Buyer sign-off: who accepted the fix (the buyer in the app, or the builder recording it on paper).
    signOff: { by: { type: ObjectId, ref: 'User' }, name: String, at: Date, note: String },
    history: { type: [snagHistorySchema], default: [] },
  },
  { timestamps: true },
);
snagSchema.index({ society: 1, number: 1 }, { unique: true });
snagSchema.index({ society: 1, unit: 1, status: 1 });
snagSchema.index({ society: 1, status: 1, createdAt: -1 });
export default mongoose.model('Snag', snagSchema);
