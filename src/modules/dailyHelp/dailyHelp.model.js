import mongoose from 'mongoose';
import { HELP_TYPES } from '../../common/constants/index.js';

export const HELP_DOC_KINDS = ['id_proof', 'address_proof', 'police_verification', 'photo', 'other'];
export const HELP_VERIFICATION = ['not_submitted', 'submitted', 'verified', 'rejected'];

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });
const documentSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: HELP_DOC_KINDS, required: true },
    files: { type: [attachmentSchema], default: [] },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const dailyHelpSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    type: { type: String, enum: HELP_TYPES, default: 'maid' },
    units: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Unit' }],
    passcode: { type: String, required: true },
    isInside: { type: Boolean, default: false },
    lastSeenAt: Date,
    // Gates the helper may enter by (set by management); empty = any gate that takes staff.
    allowedGates: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Gate' }],
    lastGate: { type: mongoose.Schema.Types.ObjectId, ref: 'Gate' }, // gate of the last scan, for "inside now" by gate
    lastGateName: { type: String, trim: true },
    active: { type: Boolean, default: true },
    photo: attachmentSchema,
    documents: { type: [documentSchema], default: [] },
    policeVerification: {
      status: { type: String, enum: HELP_VERIFICATION, default: 'not_submitted' },
      notes: { type: String, trim: true },
      verifiedAt: Date,
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    // denormalised from HelpReview so lists can show the average without a lookup
    avgRating: { type: Number, default: null },
    ratingCount: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
dailyHelpSchema.index({ society: 1, passcode: 1 }, { unique: true });
dailyHelpSchema.index({ society: 1, phone: 1 });
dailyHelpSchema.index({ society: 1, units: 1 });

export default mongoose.model('DailyHelp', dailyHelpSchema);
