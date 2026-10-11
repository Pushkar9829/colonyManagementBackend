import mongoose from 'mongoose';

export const EXTINGUISHER_TYPES = ['abc_powder', 'co2', 'water', 'foam', 'clean_agent', 'k_class', 'other'];

const { ObjectId } = mongoose.Schema.Types;

const fireExtinguisherSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    code: { type: String, required: true }, // FE-0001
    location: { type: String, required: true, trim: true },
    block: { type: ObjectId, ref: 'Block' },
    type: { type: String, enum: EXTINGUISHER_TYPES, required: true },
    capacityKg: { type: Number, min: 0 },
    installedOn: String,
    lastRefillDate: String,
    nextRefillDue: String,
    expiryDate: String, // cylinder life / hydro-test due
    lastInspectedOn: String,
    active: { type: Boolean, default: true },
    notes: { type: String, trim: true },
    alertsSent: { type: [String], default: [] },
  },
  { timestamps: true },
);
fireExtinguisherSchema.index({ society: 1, code: 1 }, { unique: true });
fireExtinguisherSchema.index({ society: 1, nextRefillDue: 1 });

export default mongoose.model('FireExtinguisher', fireExtinguisherSchema);
