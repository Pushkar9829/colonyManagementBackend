import mongoose from 'mongoose';
import { PR_STATUS } from './constants.js';

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });
const itemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1, min: 0 },
    rate: { type: Number, default: 0, min: 0 }, // paise
    amount: { type: Number, required: true, min: 0 }, // paise
  },
  { _id: false },
);
const historySchema = new mongoose.Schema(
  { by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, from: String, to: String, note: String },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } },
);

const purchaseRequestSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true }, // PR-000001
    title: { type: String, required: true, trim: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    items: { type: [itemSchema], default: [] },
    amount: { type: Number, required: true, min: 0 }, // estimated total, paise
    justification: { type: String, trim: true },
    attachments: { type: [attachmentSchema], default: [] },
    status: { type: String, enum: PR_STATUS, default: 'draft' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionNote: { type: String, trim: true },
    autoApproved: { type: Boolean, default: false },
    vendorBill: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorBill' },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);
purchaseRequestSchema.index({ society: 1, number: 1 }, { unique: true });
purchaseRequestSchema.index({ society: 1, status: 1, createdAt: -1 });
purchaseRequestSchema.index({ society: 1, requestedBy: 1, createdAt: -1 });

export default mongoose.model('PurchaseRequest', purchaseRequestSchema);
