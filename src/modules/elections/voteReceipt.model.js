import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// "This unit / person has voted" — stored apart from the ballot so turnout and double-vote checks
// never reveal how anyone voted.
const receiptSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    election: { type: ObjectId, ref: 'Election', required: true },
    voterKey: { type: String, required: true }, // unit:<id> or user:<id>, depending on eligibility
    user: { type: ObjectId, ref: 'User', required: true },
    unit: { type: ObjectId, ref: 'Unit' },
  },
  { timestamps: { createdAt: 'castAt', updatedAt: false } },
);
receiptSchema.index({ election: 1, voterKey: 1 }, { unique: true });
receiptSchema.index({ society: 1, election: 1 });

export default mongoose.model('ElectionVoteReceipt', receiptSchema);
