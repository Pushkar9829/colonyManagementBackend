import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const CONTACT_CATEGORIES = ['ambulance', 'hospital', 'police', 'fire', 'pharmacy', 'doctor', 'electrician', 'plumber', 'lift', 'gas', 'security', 'management', 'other'];

// Society-specific emergency directory, shown to everyone in display order.
const contactSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: CONTACT_CATEGORIES, default: 'other' },
    phone: { type: String, required: true, trim: true },
    altPhone: { type: String, trim: true },
    address: { type: String, trim: true },
    notes: { type: String, trim: true },
    available24x7: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
contactSchema.index({ society: 1, active: 1, order: 1 });

// Child registered by a parent so the gate can recognise them leaving alone.
const childSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    unit: { type: ObjectId, ref: 'Unit', required: true },
    name: { type: String, required: true, trim: true },
    age: { type: Number, min: 0, max: 18 },
    photoUrl: { type: String },
    notes: { type: String, trim: true }, // "may go to the tuition in B-block alone"
    alertOnExit: { type: Boolean, default: true },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
childSchema.index({ society: 1, unit: 1 });
childSchema.index({ society: 1, alertOnExit: 1, name: 1 });

// Guard saw a registered child leaving alone. Parents must acknowledge; unanswered alerts escalate.
const childAlertSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    child: { type: ObjectId, ref: 'ResidentChild', required: true },
    unit: { type: ObjectId, ref: 'Unit', required: true },
    gate: { type: String, trim: true, default: 'Main gate' }, // gate name (old alerts have only this)
    gateId: { type: ObjectId, ref: 'Gate' },
    note: { type: String, trim: true },
    raisedBy: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['open', 'acknowledged'], default: 'open' },
    acknowledgedBy: { type: ObjectId, ref: 'User' },
    acknowledgedAt: Date,
    response: { type: String, enum: ['ok', 'stop'] }, // parent: "it's fine" / "stop the child"
    ackNote: { type: String, trim: true },
    escalatedAt: Date,
  },
  { timestamps: true },
);
childAlertSchema.index({ society: 1, status: 1, createdAt: -1 });
childAlertSchema.index({ society: 1, unit: 1, createdAt: -1 });

export const EmergencyContact = mongoose.model('EmergencyContact', contactSchema);
export const Child = mongoose.model('ResidentChild', childSchema);
export const ChildAlert = mongoose.model('ChildExitAlert', childAlertSchema);
