import mongoose from 'mongoose';

export const LEASE_STATUS = ['active', 'ended'];
export const POLICE_STATUS = ['not_submitted', 'submitted', 'verified', 'rejected'];

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

// A rental agreement for one unit. Ended leases are kept as the unit's tenant history.
const leaseSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    tenantMembership: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership', required: true },
    tenantUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ownerMembership: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership' },
    ownerUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ownerName: { type: String, trim: true }, // non-resident landlord without an app login
    ownerPhone: { type: String, trim: true },
    startDate: { type: String, required: true }, // YYYY-MM-DD
    endDate: { type: String, required: true },
    rent: { type: Number, min: 0 }, // paise per month, optional
    securityDeposit: { type: Number, min: 0 }, // paise, optional
    agreement: { type: [attachmentSchema], default: [] },
    policeVerification: {
      status: { type: String, enum: POLICE_STATUS, default: 'not_submitted' },
      documents: { type: [attachmentSchema], default: [] },
      reference: { type: String, trim: true }, // police station acknowledgement number
      notes: { type: String, trim: true },
      verifiedAt: Date,
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    emergencyContact: {
      name: { type: String, trim: true },
      relation: { type: String, trim: true },
      phone: { type: String, trim: true },
    },
    notes: { type: String, trim: true },
    status: { type: String, enum: LEASE_STATUS, default: 'active' },
    endedAt: Date,
    endReason: { type: String, trim: true },
    movedOut: { type: Boolean, default: false },
    endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // reminder keys already sent ('30', '7', 'expired'), so the job never repeats one
    remindersSent: { type: [String], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
// At most one running lease per unit.
leaseSchema.index({ society: 1, unit: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
leaseSchema.index({ society: 1, status: 1, endDate: 1 });
leaseSchema.index({ society: 1, tenantUser: 1 });
leaseSchema.index({ society: 1, unit: 1, startDate: -1 });

export default mongoose.model('Lease', leaseSchema);
