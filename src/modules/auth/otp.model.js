import mongoose from 'mongoose';

// One-time login codes. The code is stored hashed; the document deletes itself when it expires.
const otpSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true },
    purpose: { type: String, enum: ['login'], default: 'login' },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    sendCount: { type: Number, default: 1 }, // sends within the current window
    windowStartedAt: { type: Date, default: Date.now },
    lastSentAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
otpSchema.index({ phone: 1, purpose: 1 }, { unique: true });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 }); // keep 1h after expiry for send-rate limits

export default mongoose.model('Otp', otpSchema);
