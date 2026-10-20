import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Secrets are AES-GCM sealed (common/utils/secretBox.js); backup codes are keyed hashes, removed when used.
const mfaSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    secret: String,
    pendingSecret: String, // set by /auth/mfa/setup until confirmed with a code
    pendingCreatedAt: Date,
    backupCodes: { type: [String], default: undefined },
    lastUsedStep: Number, // last accepted TOTP time step, so a code can't be replayed inside its window
    enabledAt: Date,
  },
  { _id: false },
);

// A person's login. What they can do in a society lives on Membership (one per society role / flat).
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' }, // whole-account switch
    // Platform team (no society needed): 'super_admin' = Owner (every permission); 'staff' = a member whose
    // permissions come from platformRoleId. platformStatus 'inactive' switches only platform access off.
    platformRole: { type: String, enum: ['super_admin', 'staff'] },
    platformRoleId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformRole' },
    platformStatus: { type: String, enum: ['active', 'inactive'] },
    platformAddedAt: Date,
    // Reseller admin (white-label partner console): sees only this reseller's keys and societies.
    reseller: { type: mongoose.Schema.Types.ObjectId, ref: 'Reseller' },
    lastMembership: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership' }, // reopened after login
    notificationPrefs: {
      sms: { type: Boolean, default: true },
      whatsapp: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
    },
    lastLoginAt: Date,
    // Two-step verification (TOTP). Whole subdocument is select:false — read it only with .select('+mfa').
    mfa: { type: mfaSchema, select: false },
    // Set when the account was anonymised after an approved deletion request (privacy module).
    anonymisedAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });

userSchema.methods.verifyPassword = function verifyPassword(password) {
  return bcrypt.compare(password, this.passwordHash);
};

userSchema.statics.hashPassword = (password) => bcrypt.hash(password, 10);

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    delete ret.mfa;
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('User', userSchema);
