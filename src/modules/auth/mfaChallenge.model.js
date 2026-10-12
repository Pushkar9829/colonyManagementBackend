import mongoose from 'mongoose';

// The second login step after a correct password / SMS code. One per mfaToken (keyed by its jti):
// counts wrong codes for lockout and is claimed once on success, so a token can't be replayed.
const mfaChallengeSchema = new mongoose.Schema(
  {
    jti: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    via: { type: String, enum: ['password', 'otp'], required: true },
    attempts: { type: Number, default: 0 },
    usedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
mfaChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('MfaChallenge', mfaChallengeSchema);
