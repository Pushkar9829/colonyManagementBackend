import mongoose from 'mongoose';
import { SOS_STATUS, SOS_TYPES } from '../../common/constants/index.js';

const sosSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    type: { type: String, enum: SOS_TYPES, default: 'other' },
    message: { type: String, trim: true },
    location: { type: String, trim: true }, // free text e.g. "Clubhouse", "Lift B2"
    status: { type: String, enum: SOS_STATUS, default: 'active' },
    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    acknowledgedAt: Date,
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
    resolutionNote: { type: String, trim: true },
  },
  { timestamps: true },
);
sosSchema.index({ society: 1, status: 1, createdAt: -1 });

export default mongoose.model('SosAlert', sosSchema);
