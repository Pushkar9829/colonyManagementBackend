import mongoose from 'mongoose';

// Per-society knobs for the security area (one document per society, created on first save).
const securitySettingsSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true, unique: true },
    // Visitor waiting for approval this long -> re-alert the whole household and ask the guard to call.
    escalationSeconds: { type: Number, default: 90, min: 15, max: 3600 },
    parcelReminderHours: { type: Number, default: 24, min: 1, max: 240 },
    // Grace after a patrol round's window before it counts as missed.
    patrolGraceMinutes: { type: Number, default: 10, min: 0, max: 240 },
    visitorParkingOverstayGraceMinutes: { type: Number, default: 15, min: 0, max: 600 },
    // Unacknowledged child-exit alert this long -> escalate to management and guards.
    childAlertEscalationMinutes: { type: Number, default: 3, min: 1, max: 60 },
    // ANPR/RFID: let unknown vehicles out (true) or hold them for the guard (false).
    allowUnknownExit: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export default mongoose.model('SecuritySettings', securitySettingsSchema);
