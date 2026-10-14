import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// What can be logged at a gate. Entries of a kind the gate does not take are refused (guards can
// override with the "resident confirmed by phone" path where it exists).
export const GATE_KINDS = ['visitors', 'vehicles', 'staff', 'deliveries'];
export const KIND_FLAG = { visitors: 'allowVisitors', vehicles: 'allowVehicles', staff: 'allowStaff', deliveries: 'allowDeliveries' };

export const normalizeGateName = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

// A physical entrance of the society. Every society has at least one (created lazily as "Main gate").
const gateSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true }, // lower-cased name: names are unique per society, ignoring case
    code: { type: String, required: true, trim: true, uppercase: true }, // short label for devices and badges: MAIN, G2
    allowVisitors: { type: Boolean, default: true },
    allowVehicles: { type: Boolean, default: true },
    allowStaff: { type: Boolean, default: true }, // daily help and society staff
    allowDeliveries: { type: Boolean, default: true },
    isPedestrianOnly: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    notes: { type: String, trim: true },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
gateSchema.index({ society: 1, nameKey: 1 }, { unique: true });
gateSchema.index({ society: 1, code: 1 }, { unique: true });
gateSchema.index({ society: 1, active: 1, order: 1 });
gateSchema.pre('validate', function setKey() {
  if (this.name) this.nameKey = normalizeGateName(this.name);
});

// Which gate a guard is working at right now. Chosen in the gate console (or taken from the shift
// handover they acknowledged); one row per guard, overwritten when they move.
const gatePostSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    guard: { type: ObjectId, ref: 'User', required: true },
    gate: { type: ObjectId, ref: 'Gate', required: true },
    gateName: { type: String, trim: true },
    since: { type: Date, required: true },
    source: { type: String, enum: ['console', 'handover'], default: 'console' },
  },
  { timestamps: true },
);
gatePostSchema.index({ society: 1, guard: 1 }, { unique: true });

export const Gate = mongoose.model('Gate', gateSchema);
export const GatePost = mongoose.model('GatePost', gatePostSchema);
export default Gate;
