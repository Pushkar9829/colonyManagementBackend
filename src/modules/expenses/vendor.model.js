import mongoose from 'mongoose';
import { TDS_SECTIONS, VENDOR_CATEGORIES } from './constants.js';

const bankSchema = new mongoose.Schema(
  {
    accountName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    ifsc: { type: String, trim: true, uppercase: true },
    bankName: { type: String, trim: true },
    upi: { type: String, trim: true },
  },
  { _id: false },
);

const vendorSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: VENDOR_CATEGORIES, default: 'other' },
    contactPerson: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    gstin: { type: String, trim: true, uppercase: true },
    pan: { type: String, trim: true, uppercase: true },
    address: { type: String, trim: true },
    bank: { type: bankSchema, default: undefined },
    defaultAccount: { type: String, default: '5900' }, // expense account code pre-filled on new bills
    tdsSection: { type: String, enum: TDS_SECTIONS },
    tdsRate: { type: Number, min: 0, max: 30, default: 0 }, // percent
    notes: { type: String, trim: true },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
vendorSchema.index({ society: 1, name: 1 });
vendorSchema.index({ society: 1, active: 1, category: 1 });

export default mongoose.model('Vendor', vendorSchema);
