import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// A place guards must visit, identified by a printed QR code.
const checkpointSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    location: { type: String, trim: true },
    code: { type: String, required: true }, // random, printed in the QR as "CHKPT:<code>"
    lat: Number,
    lng: Number,
    radiusM: { type: Number, default: 75, min: 10, max: 1000 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
checkpointSchema.index({ society: 1, code: 1 }, { unique: true });
checkpointSchema.index({ society: 1, active: 1, name: 1 });

// A schedule: visit these checkpoints (in order) every `frequencyMinutes` between start and end time on `days`.
const routeSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    checkpoints: [{ type: ObjectId, ref: 'PatrolCheckpoint' }],
    frequencyMinutes: { type: Number, required: true, min: 15, max: 1440 },
    startTime: { type: String, required: true }, // "HH:MM" local; end <= start means the window runs past midnight
    endTime: { type: String, required: true },
    days: [{ type: Number, min: 0, max: 6 }], // empty = every day
    enforceOrder: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
routeSchema.index({ society: 1, active: 1 });

// One scheduled round of a route (created on first scan or when the missed-round job closes it).
const roundSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    route: { type: ObjectId, ref: 'PatrolRoute', required: true },
    dueAt: { type: Date, required: true },
    windowEnd: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'in_progress', 'completed', 'partial', 'missed'], default: 'pending' },
    expected: { type: Number, default: 0 },
    scans: [
      {
        _id: false,
        checkpoint: { type: ObjectId, ref: 'PatrolCheckpoint' },
        scannedAt: Date,
        guard: { type: ObjectId, ref: 'User' },
        gpsOk: Boolean,
      },
    ],
    inOrder: { type: Boolean, default: true },
    missedCheckpoints: [{ type: ObjectId, ref: 'PatrolCheckpoint' }],
    startedAt: Date,
    completedAt: Date,
    alertedAt: Date,
  },
  { timestamps: true },
);
roundSchema.index({ route: 1, dueAt: 1 }, { unique: true });
roundSchema.index({ society: 1, dueAt: -1 });
roundSchema.index({ society: 1, status: 1, dueAt: -1 });

// Every QR scan, including ones outside any scheduled round.
const scanSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    checkpoint: { type: ObjectId, ref: 'PatrolCheckpoint', required: true },
    guard: { type: ObjectId, ref: 'User', required: true },
    scannedAt: { type: Date, required: true },
    lat: Number,
    lng: Number,
    accuracyM: Number,
    distanceM: Number,
    gpsOk: Boolean, // null when GPS was not available or the checkpoint has no coordinates
    rounds: [{ type: ObjectId, ref: 'PatrolRound' }],
    note: { type: String, trim: true },
  },
  { timestamps: true },
);
scanSchema.index({ society: 1, scannedAt: -1 });
scanSchema.index({ society: 1, guard: 1, scannedAt: -1 });

export const Checkpoint = mongoose.model('PatrolCheckpoint', checkpointSchema);
export const PatrolRoute = mongoose.model('PatrolRoute', routeSchema);
export const PatrolRound = mongoose.model('PatrolRound', roundSchema);
export const PatrolScan = mongoose.model('PatrolScan', scanSchema);
