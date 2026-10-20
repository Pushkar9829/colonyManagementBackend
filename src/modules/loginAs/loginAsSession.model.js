import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// One "Log in as" session: someone higher up opened a time-limited view of another member's account.
// Names are copied so the history still reads well after people are renamed or removed.
const loginAsSessionSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    actor: { type: ObjectId, ref: 'User', required: true },
    actorName: { type: String, required: true },
    actorLevel: { type: String, enum: ['platform', 'admin', 'subadmin'], required: true },
    target: { type: ObjectId, ref: 'User', required: true },
    targetName: { type: String, required: true },
    targetMembership: { type: ObjectId, ref: 'Membership', required: true },
    targetRole: { type: String, required: true },
    targetUnitLabel: String,
    reason: { type: String, required: true, trim: true },
    startedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    endedAt: Date,
    endedReason: { type: String, enum: ['exit', 'expired', 'replaced'] },
    // How many API calls were made in the session (every one is attributable through this record).
    requests: { type: Number, default: 0 },
    lastSeenAt: Date,
    ip: String,
  },
  { timestamps: true },
);
loginAsSessionSchema.index({ society: 1, startedAt: -1 });
loginAsSessionSchema.index({ target: 1, startedAt: -1 });
loginAsSessionSchema.index({ actor: 1, endedAt: 1 });
loginAsSessionSchema.index({ endedAt: 1, expiresAt: 1 });

export default mongoose.model('LoginAsSession', loginAsSessionSchema);
