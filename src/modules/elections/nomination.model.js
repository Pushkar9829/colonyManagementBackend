import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// pending_acceptance: nominated by someone else, waiting for the candidate to accept
// accepted:           candidate agreed, waiting for scrutiny by the election officer
export const NOMINATION_STATUS = ['pending_acceptance', 'accepted', 'approved', 'rejected', 'declined', 'withdrawn'];

const nominationSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    election: { type: ObjectId, ref: 'Election', required: true },
    position: { type: ObjectId, required: true },
    candidate: { type: ObjectId, ref: 'Membership', required: true },
    candidateUser: { type: ObjectId, ref: 'User', required: true },
    candidateName: { type: String, required: true },
    unitLabel: String,
    nominatedBy: { type: ObjectId, ref: 'User', required: true },
    nominatedByName: String,
    statement: { type: String, trim: true }, // manifesto / why vote for me
    status: { type: String, enum: NOMINATION_STATUS, required: true },
    acceptedAt: Date,
    scrutinyNote: { type: String, trim: true },
    scrutinizedBy: { type: ObjectId, ref: 'User' },
    scrutinizedAt: Date,
  },
  { timestamps: true },
);
// One live nomination per candidate per post (withdrawn/declined/rejected may be re-filed).
nominationSchema.index(
  { election: 1, position: 1, candidate: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending_acceptance', 'accepted', 'approved'] } }, name: 'one_live_nomination' },
);
nominationSchema.index({ society: 1, election: 1, status: 1 });

export default mongoose.model('ElectionNomination', nominationSchema);
