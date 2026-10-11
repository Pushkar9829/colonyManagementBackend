import mongoose from 'mongoose';

// Refresh tokens are stored hashed. Each refresh rotates the token; reuse of a revoked one kills the family.
const refreshTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true },
    membership: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership' }, // society context of this session; null = platform
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    userAgent: String,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ user: 1, family: 1 });

export default mongoose.model('RefreshToken', refreshTokenSchema);
