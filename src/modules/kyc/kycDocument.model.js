import mongoose from 'mongoose';

export const ID_PROOFS = ['aadhaar', 'pan', 'passport', 'voter_id', 'driving_licence'];
export const OWNERSHIP_DOCS = ['sale_deed', 'possession_letter', 'allotment_letter'];
export const KYC_TYPES = [...ID_PROOFS, ...OWNERSHIP_DOCS, 'photo', 'other'];
export const KYC_STATUS = ['pending', 'verified', 'rejected'];

export const categoryOf = (type) => {
  if (ID_PROOFS.includes(type)) return 'id_proof';
  if (OWNERSHIP_DOCS.includes(type)) return 'ownership';
  return type === 'photo' ? 'photo' : 'other';
};

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

// A member's identity / ownership document. Document numbers are never stored in full —
// only the last 4 characters, enough for an admin to match the physical copy (Aadhaar rules).
const kycDocumentSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    membership: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: KYC_TYPES, required: true },
    category: { type: String, enum: ['id_proof', 'ownership', 'photo', 'other'], required: true },
    last4: { type: String, trim: true, maxlength: 4 },
    nameOnDocument: { type: String, trim: true },
    files: { type: [attachmentSchema], default: [] },
    status: { type: String, enum: KYC_STATUS, default: 'pending' },
    rejectionReason: { type: String, trim: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
  },
  { timestamps: true },
);
// One current document per person, flat and type; a resubmission replaces it.
kycDocumentSchema.index({ society: 1, membership: 1, type: 1 }, { unique: true });
kycDocumentSchema.index({ society: 1, status: 1, createdAt: 1 });
kycDocumentSchema.index({ society: 1, unit: 1 });

export default mongoose.model('KycDocument', kycDocumentSchema);
