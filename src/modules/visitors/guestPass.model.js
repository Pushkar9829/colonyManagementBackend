import mongoose from 'mongoose';

// Pre-approved entry created by a resident; the guest shows the code (or its QR) at the gate.
// A recurring pass (tutor every Mon/Wed 17:00-19:00) is valid only inside its weekly window,
// between validFrom and validTo, and is not used up by entries.
const guestPassSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    guestName: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    purpose: { type: String, default: 'guest' },
    code: { type: String, required: true },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },
    maxUses: { type: Number, default: 1, min: 1 },
    usedCount: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'used', 'cancelled', 'expired'], default: 'active' },
    kind: { type: String, enum: ['one_time', 'recurring'], default: 'one_time' },
    recurrence: {
      days: [{ type: Number, min: 0, max: 6 }], // 0 = Sunday
      startTime: String, // "HH:MM" local
      endTime: String,
    },
    // Gates the pass may be used at; empty = any gate.
    gates: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Gate' }],
    frequentVisitor: { type: mongoose.Schema.Types.ObjectId, ref: 'FrequentVisitor' },
    lastUsedAt: Date,
  },
  { timestamps: true },
);
guestPassSchema.index({ society: 1, code: 1, status: 1 });
guestPassSchema.index({ society: 1, unit: 1, createdAt: -1 });

export default mongoose.model('GuestPass', guestPassSchema);
