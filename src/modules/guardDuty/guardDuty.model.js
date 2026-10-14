import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const SHIFTS = ['morning', 'afternoon', 'evening', 'night'];
export const INCIDENT_TYPES = ['theft', 'trespass', 'suspicious', 'fight', 'accident', 'damage', 'fire', 'medical', 'lost_found', 'noise', 'other'];
export const SEVERITY = ['low', 'medium', 'high', 'critical'];
export const OB_CATEGORIES = ['note', 'round', 'visitor', 'vehicle', 'incident', 'handover', 'key', 'maintenance', 'other'];

// Shift handover: what the outgoing guard passes on; the incoming guard acknowledges it.
const handoverSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    shift: { type: String, enum: SHIFTS, required: true },
    gate: { type: String, trim: true, default: 'Main gate' }, // gate name (old handovers have only this)
    gateId: { type: ObjectId, ref: 'Gate' },
    fromGuard: { type: ObjectId, ref: 'User', required: true },
    toGuard: { type: ObjectId, ref: 'User' },
    notes: { type: String, trim: true },
    incidents: { type: String, trim: true },
    keys: [{ _id: false, name: { type: String, trim: true }, status: { type: String, enum: ['with_guard', 'issued', 'missing'], default: 'with_guard' }, holder: { type: String, trim: true } }],
    pendingItems: [{ _id: false, text: { type: String, trim: true }, done: { type: Boolean, default: false } }],
    status: { type: String, enum: ['open', 'acknowledged'], default: 'open' },
    acknowledgedBy: { type: ObjectId, ref: 'User' },
    acknowledgedAt: Date,
    ackNote: { type: String, trim: true },
  },
  { timestamps: true },
);
handoverSchema.index({ society: 1, createdAt: -1 });
handoverSchema.index({ society: 1, status: 1 });

const incidentSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true }, // INC-000012
    type: { type: String, enum: INCIDENT_TYPES, required: true },
    severity: { type: String, enum: SEVERITY, default: 'medium' },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    location: { type: String, trim: true },
    occurredAt: { type: Date, required: true },
    photos: [{ _id: false, url: String, mimetype: String, name: String }],
    visitor: { type: ObjectId, ref: 'Visitor' },
    vehicleNumber: { type: String, trim: true, uppercase: true },
    vehicle: { type: ObjectId, ref: 'Vehicle' },
    unit: { type: ObjectId, ref: 'Unit' },
    reportedBy: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    actionTaken: { type: String, trim: true },
    closedBy: { type: ObjectId, ref: 'User' },
    closedAt: Date,
  },
  { timestamps: true },
);
incidentSchema.index({ society: 1, occurredAt: -1 });
incidentSchema.index({ society: 1, status: 1, occurredAt: -1 });
incidentSchema.index({ society: 1, number: 1 }, { unique: true });

// Daily occurrence book: a chronological log per local day; handovers and incidents add entries automatically.
const occurrenceSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD (IST)
    at: { type: Date, required: true },
    category: { type: String, enum: OB_CATEGORIES, default: 'note' },
    text: { type: String, required: true, trim: true },
    by: { type: ObjectId, ref: 'User' },
    refModel: { type: String, enum: ['Handover', 'Incident'] },
    ref: { type: ObjectId },
  },
  { timestamps: true },
);
occurrenceSchema.index({ society: 1, date: 1, at: 1 });

export const Handover = mongoose.model('GuardHandover', handoverSchema);
export const Incident = mongoose.model('SecurityIncident', incidentSchema);
export const OccurrenceEntry = mongoose.model('OccurrenceEntry', occurrenceSchema);
