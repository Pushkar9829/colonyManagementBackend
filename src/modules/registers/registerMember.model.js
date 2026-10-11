import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Register of members (I-Form). One entry per person admitted as a member of the society.
const registerMemberSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    memberNo: { type: Number, required: true }, // serial number in the register
    membership: { type: ObjectId, ref: 'Membership' }, // linked app account, when the member has one
    user: { type: ObjectId, ref: 'User' },
    name: { type: String, required: true, trim: true },
    unit: { type: ObjectId, ref: 'Unit' },
    unitLabel: String,
    address: { type: String, trim: true },
    occupation: { type: String, trim: true },
    ageOnAdmission: { type: Number, min: 18, max: 120 },
    admissionDate: { type: String, required: true }, // YYYY-MM-DD
    entranceFee: { type: Number, default: 0, min: 0 }, // paise
    status: { type: String, enum: ['active', 'ceased'], default: 'active' },
    cessationDate: String,
    cessationReason: { type: String, trim: true },
    remarks: { type: String, trim: true },
  },
  { timestamps: true },
);
registerMemberSchema.index({ society: 1, memberNo: 1 }, { unique: true });
registerMemberSchema.index({ society: 1, status: 1, name: 1 });
registerMemberSchema.index({ society: 1, user: 1 });

export default mongoose.model('RegisterMember', registerMemberSchema);
