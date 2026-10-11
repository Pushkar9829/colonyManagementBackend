import mongoose from 'mongoose';
import { FEATURE_KEYS } from './features.catalogue.js';

const overrideSchema = new mongoose.Schema(
  {
    key: { type: String, enum: FEATURE_KEYS, required: true },
    enabled: { type: Boolean, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true },
  },
  { _id: false },
);

// Per-society deviations from the plan defaults, set by the platform owner.
const societyFeaturesSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true, unique: true },
    overrides: { type: [overrideSchema], default: [] },
  },
  { timestamps: true },
);

export default mongoose.model('SocietyFeatures', societyFeaturesSchema);
