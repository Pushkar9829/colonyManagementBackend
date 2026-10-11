import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const ELECTION_STATUS = ['draft', 'nominations', 'scrutiny', 'voting', 'closed', 'published', 'cancelled'];
// unit_owner: one vote per flat, cast by an owner (default, per co-operative practice)
// unit_any:   one vote per flat, cast by any resident of it
// member:     one vote per owner (a person owning two flats still votes once)
export const ELIGIBILITY = ['unit_owner', 'unit_any', 'member'];

const positionSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  seats: { type: Number, default: 1, min: 1, max: 50 },
  description: { type: String, trim: true },
});

const candidateResultSchema = new mongoose.Schema(
  { nomination: ObjectId, name: String, unitLabel: String, votes: Number, elected: Boolean },
  { _id: false },
);

const resultSchema = new mongoose.Schema(
  {
    position: ObjectId,
    title: String,
    seats: Number,
    ballots: Number, // ballots that voted on this position
    candidates: [candidateResultSchema],
    winners: [ObjectId], // nomination ids
    unopposed: Boolean,
    tie: Boolean,
    tiedCandidates: [ObjectId],
    tieNote: String,
    tieResolution: String,
  },
  { _id: false },
);

const auditSchema = new mongoose.Schema(
  { at: { type: Date, default: Date.now }, by: { type: ObjectId, ref: 'User' }, action: String, note: String },
  { _id: false },
);

const electionSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    positions: { type: [positionSchema], default: [] },
    eligibility: { type: String, enum: ELIGIBILITY, default: 'unit_owner' },
    nominationStart: Date,
    nominationEnd: Date,
    votingStart: Date,
    votingEnd: Date,
    status: { type: String, enum: ELECTION_STATUS, default: 'draft' },
    officer: { type: ObjectId, ref: 'User' }, // returning officer besides admins
    eligibleCount: Number, // snapshot when voting opens
    ballotsCast: { type: Number, default: 0 },
    results: { type: [resultSchema], default: undefined },
    resultsComputedAt: Date,
    publishedAt: Date,
    notice: { type: ObjectId, ref: 'Notice' },
    audit: { type: [auditSchema], default: [] },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
electionSchema.index({ society: 1, number: 1 }, { unique: true });
electionSchema.index({ society: 1, status: 1, createdAt: -1 });

export default mongoose.model('Election', electionSchema);
