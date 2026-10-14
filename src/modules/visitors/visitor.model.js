import mongoose from 'mongoose';
import { VISITOR_PURPOSE, VISITOR_STATUS } from '../../common/constants/index.js';

const visitorSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    purpose: { type: String, enum: VISITOR_PURPOSE, default: 'guest' },
    company: { type: String, trim: true }, // delivery / cab company
    vehicleNumber: { type: String, trim: true, uppercase: true },
    guests: { type: Number, default: 1, min: 1 },
    photoUrl: { type: String },
    status: { type: String, enum: VISITOR_STATUS, default: 'pending' },
    pass: { type: mongoose.Schema.Types.ObjectId, ref: 'GuestPass' },
    loggedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    respondedAt: Date,
    note: { type: String, trim: true },
    checkInAt: Date,
    checkOutAt: Date,
    // Gate of arrival / departure, with the name as it was then (entries from before gates have neither).
    entryGate: { type: mongoose.Schema.Types.ObjectId, ref: 'Gate' },
    entryGateName: { type: String, trim: true },
    exitGate: { type: mongoose.Schema.Types.ObjectId, ref: 'Gate' },
    exitGateName: { type: String, trim: true },
    // The gate does not take this kind of entry (or the pass is for another gate) but the guard let them
    // in after the resident confirmed by phone.
    gateOverride: {
      at: Date,
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reason: String,
    },
    // When the guard actually saw the visitor (differs from createdAt for entries synced from offline mode).
    occurredAt: Date,
    // Idempotency key from the gate device; retries with the same key return the same entry.
    clientKey: { type: String },
    offline: { type: Boolean, default: false },
    // Watchlist / blocklist hit at the gate.
    flag: {
      type: { type: String, enum: ['watch', 'block'] },
      reason: String,
      entry: { type: mongoose.Schema.Types.ObjectId, ref: 'WatchlistEntry' },
    },
    autoApproved: { type: Boolean, default: false }, // frequent visitor with auto-approve on
    frequentVisitor: { type: mongoose.Schema.Types.ObjectId, ref: 'FrequentVisitor' },
    leftAtGate: { type: Boolean, default: false }, // delivery left at the gate per household preference
    // No answer from the household in time: everyone re-alerted, guard asked to phone.
    escalatedAt: Date,
    callResident: { type: Boolean, default: false },
  },
  { timestamps: true },
);
visitorSchema.index({ society: 1, status: 1, createdAt: -1 });
visitorSchema.index({ society: 1, unit: 1, createdAt: -1 });
visitorSchema.index({ society: 1, clientKey: 1 }, { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } });
visitorSchema.index({ society: 1, 'flag.type': 1, createdAt: -1 });
visitorSchema.index({ society: 1, entryGate: 1, status: 1, createdAt: -1 });

export default mongoose.model('Visitor', visitorSchema);
