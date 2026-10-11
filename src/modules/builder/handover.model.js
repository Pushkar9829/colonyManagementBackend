import mongoose from 'mongoose';
import { HANDOVER_CATEGORIES } from './builder.constants.js';

const { ObjectId } = mongoose.Schema.Types;

const handoverItemSchema = new mongoose.Schema({
  category: { type: String, enum: HANDOVER_CATEGORIES, required: true },
  title: { type: String, required: true, trim: true },
  details: { type: String, trim: true },
  amount: { type: Number, min: 0 }, // paise, for funds
  quantity: { type: Number, min: 0 },
  status: { type: String, enum: ['pending', 'transferred', 'not_applicable'], default: 'pending' },
  reference: { type: String, trim: true }, // document number, cheque / UTR
  transferredAt: Date,
});

const signatureSchema = new mongoose.Schema({ by: { type: ObjectId, ref: 'User' }, name: String, designation: String, note: String, at: Date }, { _id: false });

const handoverSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true, unique: true },
    items: { type: [handoverItemSchema], default: [] },
    builderSignOff: signatureSchema,
    associationSignOff: signatureSchema,
    status: { type: String, enum: ['in_progress', 'awaiting_signatures', 'completed'], default: 'in_progress' },
    completedAt: Date,
  },
  { timestamps: true },
);
export default mongoose.model('Handover', handoverSchema);
