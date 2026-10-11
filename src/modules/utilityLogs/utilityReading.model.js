import mongoose from 'mongoose';
import { POINT_KINDS } from './utilityPoint.model.js';

export const SHIFTS = ['morning', 'afternoon', 'evening', 'night'];

const { ObjectId } = mongoose.Schema.Types;

// One log entry. Only the fields of the point's kind are filled.
const utilityReadingSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    point: { type: ObjectId, ref: 'UtilityPoint', required: true },
    kind: { type: String, enum: POINT_KINDS, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    shift: { type: String, enum: SHIFTS },
    at: { type: Date, default: Date.now },
    // dg + pump: hour meter
    hoursStart: Number,
    hoursEnd: Number,
    runHours: Number,
    // pump without an hour meter
    runMinutes: Number,
    // dg diesel (litres)
    dieselFilled: Number,
    dieselConsumed: Number,
    dieselStock: Number, // after this entry
    dieselCost: Number, // paise, for fills
    // tank
    levelPercent: Number,
    levelLitres: Number,
    // stp / wtp
    values: { type: [new mongoose.Schema({ key: String, label: String, unit: String, value: Number, outOfRange: Boolean }, { _id: false })], default: undefined },
    outOfRange: { type: Boolean, default: false },
    // meter (kWh)
    meterReading: Number,
    consumption: Number,
    notes: { type: String, trim: true },
    recordedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
utilityReadingSchema.index({ society: 1, kind: 1, date: -1 });
utilityReadingSchema.index({ society: 1, point: 1, at: -1 });

export default mongoose.model('UtilityReading', utilityReadingSchema);
