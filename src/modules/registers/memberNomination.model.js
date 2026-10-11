import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const nomineeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    relation: { type: String, trim: true },
    address: { type: String, trim: true },
    dateOfBirth: String,
    sharePercent: { type: Number, required: true, min: 0.01, max: 100 },
    guardian: { type: String, trim: true }, // for a minor nominee
  },
  { _id: false },
);

// Nomination register: whom a member's shares and interest pass to. A new nomination revokes the previous one.
const memberNominationSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    member: { type: ObjectId, ref: 'RegisterMember', required: true },
    nominees: { type: [nomineeSchema], required: true },
    witnesses: [{ _id: false, name: { type: String, trim: true }, address: { type: String, trim: true } }],
    nominationDate: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    revokedAt: Date,
    remarks: { type: String, trim: true },
    recordedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
memberNominationSchema.index({ society: 1, member: 1, status: 1 });

export default mongoose.model('MemberNomination', memberNominationSchema);
