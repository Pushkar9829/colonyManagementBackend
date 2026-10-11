import mongoose from 'mongoose';

export const DEVICE_TYPES = ['anpr', 'rfid', 'barrier', 'meter', 'biometric', 'other'];
// What a key may do. Modules check these with authenticateDevice(scope).
export const DEVICE_SCOPES = ['gate:events', 'gate:commands', 'meters:write', 'attendance:write'];

// API key for a hardware integration (camera, RFID reader, smart meter...). Stored hashed; shown once on creation.
const deviceKeySchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true }, // "Main gate ANPR camera"
    type: { type: String, enum: DEVICE_TYPES, default: 'other' },
    location: { type: String, trim: true },
    scopes: [{ type: String, enum: DEVICE_SCOPES }],
    prefix: { type: String, required: true }, // first chars, to recognise a key in lists/logs
    keyHash: { type: String, required: true, unique: true },
    active: { type: Boolean, default: true },
    lastUsedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
deviceKeySchema.index({ society: 1, active: 1 });

export default mongoose.model('DeviceKey', deviceKeySchema);
