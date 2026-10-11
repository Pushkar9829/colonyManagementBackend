import mongoose from 'mongoose';

// A household's regular visitor (tutor, relative, regular cab). Enables one-tap passes and optional auto-approval.
const frequentVisitorSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    phoneKey: { type: String },
    purpose: { type: String, default: 'guest' },
    company: { type: String, trim: true },
    vehicleNumber: { type: String, trim: true, uppercase: true },
    // When true, a gate entry with this phone number for this unit is let in without asking the household.
    autoApprove: { type: Boolean, default: false },
    visits: { type: Number, default: 0 },
    lastVisitAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
frequentVisitorSchema.index({ society: 1, unit: 1, phoneKey: 1 });
frequentVisitorSchema.index({ society: 1, unit: 1, name: 1 });

export default mongoose.model('FrequentVisitor', frequentVisitorSchema);
