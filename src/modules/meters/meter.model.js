import mongoose from 'mongoose';

export const METER_TYPES = ['water', 'electricity', 'gas'];
export const METER_UNITS = { water: 'kL', electricity: 'kWh', gas: 'SCM' };
export const TYPE_LABELS = { water: 'Water', electricity: 'Electricity', gas: 'Gas' };

// A utility meter fitted to a unit. Consumption = (reading delta) x multiplier (CT ratio / pulse factor).
// A replaced meter is kept (inactive) with its final reading; the new meter is a new document.
// billedReading/billedAt mark how far consumption has been charged, so a late reading is billed next
// month instead of being lost or charged twice.
const meterSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    block: { type: mongoose.Schema.Types.ObjectId, ref: 'Block' }, // copied from the unit for per-block sheets
    type: { type: String, enum: METER_TYPES, required: true },
    serial: { type: String, required: true, trim: true, uppercase: true },
    multiplier: { type: Number, default: 1, min: 0.0001 },
    initialReading: { type: Number, default: 0, min: 0 },
    installedAt: { type: Date, default: Date.now },
    active: { type: Boolean, default: true },
    replacedAt: Date,
    replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Meter' },
    replaces: { type: mongoose.Schema.Types.ObjectId, ref: 'Meter' },
    lastReading: Number,
    lastReadAt: Date,
    billedReading: Number, // reading up to which consumption has been billed (initialReading until first bill)
    billedAt: Date,
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);
meterSchema.index({ society: 1, serial: 1 }, { unique: true });
meterSchema.index({ society: 1, unit: 1, type: 1 });
meterSchema.index({ society: 1, block: 1, type: 1, active: 1 });

export default mongoose.model('Meter', meterSchema);
