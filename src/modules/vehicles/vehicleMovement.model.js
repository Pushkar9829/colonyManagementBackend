import mongoose from 'mongoose';

export const MOVEMENT_SOURCES = ['anpr', 'rfid', 'manual', 'visitor'];
export const MOVEMENT_MATCH = ['resident', 'visitor', 'unknown', 'blocked', 'watch'];

// Every vehicle seen at a gate: camera plate reads, RFID tag reads, guard logs and visitor entries.
const vehicleMovementSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    plate: { type: String, trim: true, uppercase: true },
    tag: { type: String, trim: true, uppercase: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    // `gate` is the gate's name (all a movement had before gates were set up); `gateId` links the Gate.
    // Old documents only have the name, so reads and filters fall back to it.
    gate: { type: String, trim: true, default: 'Main gate' },
    gateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gate' },
    source: { type: String, enum: MOVEMENT_SOURCES, required: true },
    match: { type: String, enum: MOVEMENT_MATCH, required: true },
    decision: { type: String, enum: ['allow', 'deny'], required: true },
    reason: { type: String, trim: true },
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    visitor: { type: mongoose.Schema.Types.ObjectId, ref: 'Visitor' },
    watchlistEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'WatchlistEntry' },
    imageUrl: { type: String },
    confidence: { type: Number, min: 0, max: 1 },
    occurredAt: { type: Date, required: true },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'DeviceKey' },
    eventId: { type: String }, // device-side id; repeated deliveries of one event are ignored
    loggedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    alerted: { type: Boolean, default: false },
  },
  { timestamps: true },
);
vehicleMovementSchema.index({ society: 1, occurredAt: -1 });
vehicleMovementSchema.index({ society: 1, plate: 1, occurredAt: -1 });
vehicleMovementSchema.index({ society: 1, match: 1, occurredAt: -1 });
vehicleMovementSchema.index({ society: 1, device: 1, eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } });

export default mongoose.model('VehicleMovement', vehicleMovementSchema);
