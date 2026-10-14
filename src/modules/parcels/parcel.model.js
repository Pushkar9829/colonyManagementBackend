import mongoose from 'mongoose';

export const PARCEL_STATUS = ['received', 'notified', 'collected', 'returned'];
export const COLLECTOR_TYPES = ['resident', 'family', 'daily_help', 'other'];

// A parcel held at the gate until the household collects it with a 4-digit OTP.
const parcelSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true }, // PCL-000123
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    recipientName: { type: String, trim: true },
    courier: { type: String, required: true, trim: true },
    trackingNo: { type: String, trim: true },
    packages: { type: Number, default: 1, min: 1 },
    photoUrl: { type: String },
    storageLocation: { type: String, trim: true }, // shelf / rack at the gate
    gate: { type: mongoose.Schema.Types.ObjectId, ref: 'Gate' }, // gate where it was received
    gateName: { type: String, trim: true },
    note: { type: String, trim: true },
    status: { type: String, enum: PARCEL_STATUS, default: 'received' },
    // Shown only to the household; the guard types it at hand-over.
    otp: { type: String, required: true, select: false },
    otpAttempts: { type: Number, default: 0, select: false },
    leftAtGate: { type: Boolean, default: false }, // delivered without approval per household preference
    visitor: { type: mongoose.Schema.Types.ObjectId, ref: 'Visitor' },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receivedAt: { type: Date, default: Date.now },
    notifiedAt: Date,
    collectedAt: Date,
    collectedBy: {
      type: { type: String, enum: COLLECTOR_TYPES },
      name: { type: String, trim: true },
    },
    handedOverBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    returnedAt: Date,
    returnReason: { type: String, trim: true },
    reminders: { type: Number, default: 0 },
    lastReminderAt: Date,
  },
  { timestamps: true },
);
parcelSchema.index({ society: 1, status: 1, receivedAt: -1 });
parcelSchema.index({ society: 1, unit: 1, receivedAt: -1 });
parcelSchema.index({ society: 1, number: 1 }, { unique: true });

export default mongoose.model('Parcel', parcelSchema);
