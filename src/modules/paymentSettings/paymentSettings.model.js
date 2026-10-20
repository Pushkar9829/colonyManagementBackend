import mongoose from 'mongoose';

// How residents' money (bills, advances, amenities, events, autopay) reaches one society.
//   own             the society's own Razorpay account (keys entered by the society admin)
//   route           the platform's Razorpay account with the society as a Route linked account
//   platform_legacy the platform's own account, as before payment settings existed. Societies without a
//                   PaymentSettings document behave like this so existing data keeps working; it cannot be chosen.
//   disabled        no online payments (new societies until they set one up)
export const MODES = ['disabled', 'own', 'route', 'platform_legacy'];
export const SELECTABLE_MODES = ['own', 'route'];
export const ROUTE_STATUSES = ['pending', 'active', 'suspended'];
// off: not switched on · setup: switched on or chosen but not ready · active: residents can pay · blocked: platform said no
export const STATUSES = ['off', 'setup', 'active', 'blocked'];

const connectionSchema = new mongoose.Schema({ ok: Boolean, at: Date, error: String }, { _id: false });

const settingsSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true, unique: true },
    mode: { type: String, enum: MODES, default: 'disabled' },
    enabled: { type: Boolean, default: false }, // the society admin switched online payments on
    status: { type: String, enum: STATUSES, default: 'off' }, // stored copy of readiness(), for lists
    statusReason: String,
    activatedAt: Date,
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Set by the platform.
    allowedModes: { type: [{ type: String, enum: SELECTABLE_MODES }], default: () => [...SELECTABLE_MODES] },
    forceDisabled: { type: Boolean, default: false },
    forceDisabledReason: { type: String, trim: true },
    forceDisabledAt: Date,

    // own: secrets are AES-GCM sealed (common/utils/secretBox.js) and never leave the server.
    own: {
      keyId: { type: String, trim: true },
      keySecret: { type: String, select: false },
      keySecretLast4: String,
      webhookSecret: { type: String, select: false },
      webhookSecretLast4: String,
      connection: connectionSchema,
    },
    // Random path segment of the society's own webhook URL (/payments/webhook/razorpay/:webhookKey).
    webhookKey: { type: String },

    // route: filled in by the platform team from the Razorpay dashboard / linked-account API.
    route: {
      linkedAccountId: { type: String, trim: true },
      status: { type: String, enum: ROUTE_STATUSES, default: 'pending' },
      kycStatus: { type: String, trim: true },
      bank: {
        accountName: { type: String, trim: true },
        accountLast4: { type: String, trim: true },
        ifsc: { type: String, trim: true, uppercase: true },
        bankName: { type: String, trim: true },
      },
      commissionPercent: { type: Number, default: 0, min: 0, max: 20 },
      refreshedAt: Date,
    },

    // Last "Test ₹1 payment".
    testPayment: {
      ok: Boolean,
      at: Date,
      mode: String,
      amount: Number,
      orderId: String,
      paymentId: String,
      error: String,
    },
  },
  { timestamps: true },
);
settingsSchema.index({ webhookKey: 1 }, { unique: true, partialFilterExpression: { webhookKey: { $type: 'string' } } });
settingsSchema.index({ status: 1, mode: 1 });

export default mongoose.model('PaymentSettings', settingsSchema);
