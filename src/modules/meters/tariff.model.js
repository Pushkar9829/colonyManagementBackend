import mongoose from 'mongoose';
import { METER_TYPES } from './meter.model.js';

// Progressive slabs: each slab's rate applies to the consumption inside its band.
// [{ upTo: 10, rate: 2000 }, { upTo: 20, rate: 3500 }, { upTo: null, rate: 5000 }] →
// first 10 units at ₹20, next 10 at ₹35, the rest at ₹50. The last slab is open-ended (upTo null).
const slabSchema = new mongoose.Schema({ upTo: { type: Number, default: null, min: 0 }, rate: { type: Number, required: true, min: 0 } }, { _id: false });

const tariffSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    type: { type: String, enum: METER_TYPES, required: true },
    name: { type: String, required: true, trim: true },
    slabs: { type: [slabSchema], required: true },
    fixedCharge: { type: Number, default: 0, min: 0 }, // paise per meter per month (meter rent / standing charge)
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
// One tariff in force per utility type.
tariffSchema.index({ society: 1, type: 1 }, { unique: true, partialFilterExpression: { active: true } });

export default mongoose.model('Tariff', tariffSchema);
