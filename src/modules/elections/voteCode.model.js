import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Short-lived confirmation code a voter re-enters to cast the ballot (deliberate, attributable act).
const voteCodeSchema = new mongoose.Schema({
  election: { type: ObjectId, ref: 'Election', required: true },
  user: { type: ObjectId, ref: 'User', required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});
voteCodeSchema.index({ election: 1, user: 1 }, { unique: true });
voteCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('ElectionVoteCode', voteCodeSchema);
