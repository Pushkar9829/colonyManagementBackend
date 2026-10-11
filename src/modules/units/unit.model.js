import mongoose from 'mongoose';
import { OCCUPANCY, UNIT_TYPES } from '../../common/constants/index.js';

const unitSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    block: { type: mongoose.Schema.Types.ObjectId, ref: 'Block', required: true },
    number: { type: String, required: true, trim: true, uppercase: true },
    floor: { type: Number },
    type: { type: String, enum: UNIT_TYPES, default: 'flat' },
    areaSqft: { type: Number, min: 0, default: 0 },
    occupancy: { type: String, enum: OCCUPANCY, default: 'vacant' },
    // denormalised "A-101" for search and display
    label: { type: String },
  },
  { timestamps: true },
);
unitSchema.index({ society: 1, block: 1, number: 1 }, { unique: true });
unitSchema.index({ society: 1, label: 1 });

export default mongoose.model('Unit', unitSchema);
