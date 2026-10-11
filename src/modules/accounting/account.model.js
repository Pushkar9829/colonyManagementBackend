import mongoose from 'mongoose';
import { ACCOUNT_TYPES } from './chart.js';

const bankDetailsSchema = new mongoose.Schema(
  {
    bankName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    ifsc: { type: String, trim: true, uppercase: true },
    branch: { type: String, trim: true },
  },
  { _id: false },
);

const accountSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    code: { type: String, required: true, match: /^\d{4}$/ },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ACCOUNT_TYPES, required: true },
    parent: { type: String }, // parent account code, for sub-accounts
    description: { type: String, trim: true },
    system: { type: Boolean, default: false }, // part of the standard chart: locked
    active: { type: Boolean, default: true },
    isBank: { type: Boolean, default: false }, // shows in bank book and reconciliation
    isCash: { type: Boolean, default: false }, // shows in cash book
    bankDetails: bankDetailsSchema,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
accountSchema.index({ society: 1, code: 1 }, { unique: true });
accountSchema.index({ society: 1, type: 1, code: 1 });

export default mongoose.model('Account', accountSchema);
