import crypto from 'node:crypto';
import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Secret ballot: the ballot holds choices only — no voter, unit, or timestamp.
// The id is random rather than an ObjectId, because ObjectIds embed their creation time and
// could be matched against the time on a voter's receipt.
const ballotSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => crypto.randomUUID() },
    society: { type: ObjectId, ref: 'Society', required: true },
    election: { type: ObjectId, ref: 'Election', required: true },
    selections: [{ _id: false, position: ObjectId, nominations: [ObjectId] }],
    // Hash of a tracker code given only to the voter, so they can check their ballot was counted.
    trackerHash: { type: String, required: true },
  },
  { timestamps: false, versionKey: false },
);
ballotSchema.index({ election: 1 });
ballotSchema.index({ election: 1, trackerHash: 1 }, { unique: true });

export default mongoose.model('ElectionBallot', ballotSchema);
