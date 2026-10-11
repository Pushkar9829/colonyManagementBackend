import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Share transfer register: sale, gift or inheritance of a flat and its shares.
const shareTransferSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    transferNo: { type: Number, required: true },
    certificate: { type: ObjectId, ref: 'ShareCertificate', required: true },
    certificateNo: Number,
    shareFrom: Number,
    shareTo: Number,
    unit: { type: ObjectId, ref: 'Unit' },
    unitLabel: String,
    transferor: { type: ObjectId, ref: 'RegisterMember', required: true },
    transferorName: String,
    transferee: { type: ObjectId, ref: 'RegisterMember', required: true },
    transfereeName: String,
    date: { type: String, required: true },
    reason: { type: String, enum: ['sale', 'gift', 'inheritance', 'other'], default: 'sale' },
    transferFee: { type: Number, default: 0, min: 0 }, // paise
    premium: { type: Number, default: 0, min: 0 }, // paise
    meetingRef: { type: String, trim: true }, // committee resolution approving the transfer
    remarks: { type: String, trim: true },
    recordedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
shareTransferSchema.index({ society: 1, transferNo: 1 }, { unique: true });
shareTransferSchema.index({ society: 1, transferor: 1 });
shareTransferSchema.index({ society: 1, transferee: 1 });

export default mongoose.model('ShareTransfer', shareTransferSchema);
