import mongoose from 'mongoose';

export const READING_SOURCES = ['manual', 'import', 'device', 'replacement'];

// A cumulative register reading. Readings of a meter never decrease over time (enforced in the service).
const meterReadingSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    meter: { type: mongoose.Schema.Types.ObjectId, ref: 'Meter', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    reading: { type: Number, required: true, min: 0 },
    readAt: { type: Date, required: true },
    period: { type: String, required: true }, // YYYY-MM (IST) of readAt
    source: { type: String, enum: READING_SOURCES, default: 'manual' },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'DeviceKey' },
    note: { type: String, trim: true },
  },
  { timestamps: true },
);
meterReadingSchema.index({ meter: 1, readAt: 1 }, { unique: true });
meterReadingSchema.index({ society: 1, meter: 1, readAt: -1 });
meterReadingSchema.index({ society: 1, unit: 1, period: 1 });

export default mongoose.model('MeterReading', meterReadingSchema);
