import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Endorsement on the back of the certificate each time it is transferred.
const endorsementSchema = new mongoose.Schema(
  {
    date: String,
    transfer: { type: ObjectId, ref: 'ShareTransfer' },
    transferNo: Number,
    fromMember: { type: ObjectId, ref: 'RegisterMember' },
    fromName: String,
    toMember: { type: ObjectId, ref: 'RegisterMember' },
    toName: String,
  },
  { _id: false },
);

// Share certificate with its distinctive share numbers (shareFrom..shareTo, inclusive).
// Numbers are never reused, so ranges never overlap across the society's certificates.
const shareCertificateSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    certificateNo: { type: Number, required: true },
    member: { type: ObjectId, ref: 'RegisterMember', required: true }, // current holder
    unit: { type: ObjectId, ref: 'Unit' },
    unitLabel: String,
    shareFrom: { type: Number, required: true, min: 1 },
    shareTo: { type: Number, required: true, min: 1 },
    shareCount: { type: Number, required: true, min: 1 },
    faceValue: { type: Number, required: true, min: 0 }, // paise per share
    issueDate: { type: String, required: true },
    status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
    cancelledReason: String,
    endorsements: { type: [endorsementSchema], default: [] },
    issuedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
shareCertificateSchema.index({ society: 1, certificateNo: 1 }, { unique: true });
shareCertificateSchema.index({ society: 1, shareFrom: 1 }, { unique: true });
shareCertificateSchema.index({ society: 1, member: 1, status: 1 });

export default mongoose.model('ShareCertificate', shareCertificateSchema);
