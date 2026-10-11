import mongoose from 'mongoose';

// One-time password reset / account invite tokens. Stored hashed; expire automatically.
const passwordResetSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    purpose: { type: String, enum: ['reset', 'invite'], default: 'reset' },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
passwordResetSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model('PasswordReset', passwordResetSchema);
