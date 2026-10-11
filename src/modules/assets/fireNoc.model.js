import mongoose from 'mongoose';
import { attachmentSchema } from './facility.shared.js';

const { ObjectId } = mongoose.Schema.Types;

// Fire department No-Objection Certificate. The one with the latest expiry is current.
const fireNocSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true, trim: true },
    issuedBy: { type: String, trim: true },
    issueDate: String,
    expiryDate: { type: String, required: true },
    notes: { type: String, trim: true },
    documents: { type: [attachmentSchema], default: [] },
    alertsSent: { type: [String], default: [] },
    by: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
fireNocSchema.index({ society: 1, expiryDate: -1 });

export default mongoose.model('FireNoc', fireNocSchema);
