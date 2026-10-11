import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const SLOT_TYPES = ['two_wheeler', 'four_wheeler', 'ev'];
export const VIOLATION_TYPES = ['wrong_slot', 'double_parking', 'no_parking_zone', 'blocking', 'visitor_overstay', 'other'];
export const EV_STATUS = ['booked', 'charging', 'completed', 'cancelled', 'no_show'];

const areaSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true }, // "Basement 1", "Tower A stilt"
    level: { type: String, trim: true },
    description: { type: String, trim: true },
  },
  { timestamps: true },
);
areaSchema.index({ society: 1, name: 1 }, { unique: true });

// A marked bay: allotted to a unit (with the unit's vehicles) or kept in the visitor pool.
const slotSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    area: { type: ObjectId, ref: 'ParkingArea', required: true },
    number: { type: String, required: true, trim: true, uppercase: true },
    type: { type: String, enum: SLOT_TYPES, default: 'four_wheeler' },
    covered: { type: Boolean, default: false },
    pool: { type: String, enum: ['resident', 'visitor'], default: 'resident' },
    unit: { type: ObjectId, ref: 'Unit' },
    vehicles: [{ type: ObjectId, ref: 'Vehicle' }],
    allottedAt: Date,
    notes: { type: String, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
slotSchema.index({ society: 1, number: 1 }, { unique: true });
slotSchema.index({ society: 1, area: 1, pool: 1 });
slotSchema.index({ society: 1, unit: 1 });
slotSchema.index({ society: 1, vehicles: 1 });

// A visitor car parked in a visitor-pool slot by the guard, with the time it should leave.
const visitorParkingSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    slot: { type: ObjectId, ref: 'ParkingSlot', required: true },
    vehicleNumber: { type: String, required: true, trim: true, uppercase: true },
    visitor: { type: ObjectId, ref: 'Visitor' },
    unit: { type: ObjectId, ref: 'Unit' }, // host household
    inAt: { type: Date, required: true },
    expectedOutAt: { type: Date, required: true },
    outAt: Date,
    status: { type: String, enum: ['active', 'completed'], default: 'active' },
    overstayAlertedAt: Date,
    assignedBy: { type: ObjectId, ref: 'User' },
    endedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
// One car per visitor slot at a time.
visitorParkingSchema.index({ slot: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
visitorParkingSchema.index({ society: 1, status: 1, expectedOutAt: 1 });

const violationSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true }, // PV-000007
    vehicleNumber: { type: String, required: true, trim: true, uppercase: true },
    vehicle: { type: ObjectId, ref: 'Vehicle' },
    unit: { type: ObjectId, ref: 'Unit' }, // owner household, when the vehicle is registered
    type: { type: String, enum: VIOLATION_TYPES, required: true },
    slot: { type: ObjectId, ref: 'ParkingSlot' },
    location: { type: String, trim: true },
    description: { type: String, trim: true },
    photos: [{ _id: false, url: String, mimetype: String, name: String }],
    fine: { type: String, trim: true }, // free text ("₹500 as per bye-law 12"); billing is separate
    status: { type: String, enum: ['open', 'disputed', 'resolved', 'dismissed'], default: 'open' },
    disputeNote: { type: String, trim: true },
    resolution: { type: String, trim: true },
    reportedBy: { type: ObjectId, ref: 'User' },
    resolvedBy: { type: ObjectId, ref: 'User' },
    resolvedAt: Date,
  },
  { timestamps: true },
);
violationSchema.index({ society: 1, status: 1, createdAt: -1 });
violationSchema.index({ society: 1, unit: 1, createdAt: -1 });
violationSchema.index({ society: 1, number: 1 }, { unique: true });

// EV chargers are booked like amenities, by local date and HH:MM slots.
const chargerSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    location: { type: String, trim: true },
    connector: { type: String, trim: true }, // Type 2, CCS2, 15A socket
    powerKw: { type: Number, min: 0 },
    ratePerKwh: { type: Number, default: 0, min: 0 }, // paise
    slotMinutes: { type: Number, default: 60, min: 15, max: 240 },
    openTime: { type: String, default: '00:00' },
    closeTime: { type: String, default: '23:59' },
    maxHoursPerBooking: { type: Number, default: 4, min: 1, max: 24 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
chargerSchema.index({ society: 1, active: 1 });

const evSessionSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    charger: { type: ObjectId, ref: 'EvCharger', required: true },
    unit: { type: ObjectId, ref: 'Unit', required: true },
    user: { type: ObjectId, ref: 'User' },
    vehicle: { type: ObjectId, ref: 'Vehicle' },
    date: { type: String, required: true }, // YYYY-MM-DD
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    status: { type: String, enum: EV_STATUS, default: 'booked' },
    startedAt: Date,
    endedAt: Date,
    kwh: { type: Number, min: 0 },
    // Estimate only (kWh x rate). Charging it to the household is the billing module's job.
    costEstimate: { type: Number, min: 0 }, // paise
    recordedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
evSessionSchema.index({ society: 1, charger: 1, date: 1, status: 1 });
evSessionSchema.index({ society: 1, unit: 1, date: -1 });

export const ParkingArea = mongoose.model('ParkingArea', areaSchema);
export const ParkingSlot = mongoose.model('ParkingSlot', slotSchema);
export const VisitorParking = mongoose.model('VisitorParking', visitorParkingSchema);
export const ParkingViolation = mongoose.model('ParkingViolation', violationSchema);
export const EvCharger = mongoose.model('EvCharger', chargerSchema);
export const EvSession = mongoose.model('EvSession', evSessionSchema);
