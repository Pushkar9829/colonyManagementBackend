import mongoose from 'mongoose';

// dg: diesel generator · tank: water tank · stp/wtp: treatment plants · meter: common-area electricity · pump
export const POINT_KINDS = ['dg', 'tank', 'stp', 'wtp', 'meter', 'pump'];

// Sensible starting parameters for treatment plants; each society can edit them.
export const DEFAULT_PARAMETERS = {
  stp: [
    { key: 'ph', label: 'pH', unit: '', min: 6.5, max: 9 },
    { key: 'bod', label: 'BOD', unit: 'mg/L', max: 30 },
    { key: 'cod', label: 'COD', unit: 'mg/L', max: 250 },
    { key: 'tss', label: 'TSS', unit: 'mg/L', max: 100 },
    { key: 'mlss', label: 'MLSS', unit: 'mg/L', min: 2500, max: 4500 },
  ],
  wtp: [
    { key: 'ph', label: 'pH', unit: '', min: 6.5, max: 8.5 },
    { key: 'tds', label: 'TDS', unit: 'ppm', max: 500 },
    { key: 'hardness', label: 'Hardness', unit: 'ppm', max: 200 },
    { key: 'chlorine', label: 'Residual chlorine', unit: 'ppm', min: 0.2, max: 1 },
  ],
};

const { ObjectId } = mongoose.Schema.Types;

const parameterSchema = new mongoose.Schema(
  { key: { type: String, required: true }, label: { type: String, required: true }, unit: String, min: Number, max: Number },
  { _id: false },
);

// Something staff take readings from: a DG set, a tank, a plant, a meter or a pump.
const utilityPointSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    kind: { type: String, enum: POINT_KINDS, required: true },
    name: { type: String, required: true, trim: true },
    location: { type: String, trim: true },
    asset: { type: ObjectId, ref: 'Asset' },
    capacity: { type: Number, min: 0 }, // litres (tank / DG fuel tank) or kVA / HP for reference
    parameters: { type: [parameterSchema], default: [] }, // stp / wtp
    dieselStock: { type: Number, default: 0 }, // dg: litres in the fuel tank
    lastHours: Number, // dg / pump: last hour-meter reading
    lastMeterReading: Number, // meter: last kWh reading
    lastReadingAt: Date,
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
utilityPointSchema.index({ society: 1, kind: 1, name: 1 }, { unique: true });

export default mongoose.model('UtilityPoint', utilityPointSchema);
