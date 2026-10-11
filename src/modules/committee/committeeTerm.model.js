import mongoose from 'mongoose';

export const POSITIONS = ['chairman', 'president', 'vice_president', 'secretary', 'joint_secretary', 'treasurer', 'member', 'co_opted', 'other'];
// Offices only one person may hold at a time within a term.
export const SINGLE_HOLDER = ['chairman', 'president', 'vice_president', 'secretary', 'treasurer'];
// Display / signing order on letters and minutes.
export const POSITION_RANK = Object.fromEntries(POSITIONS.map((p, i) => [p, i]));

const positionSchema = new mongoose.Schema(
  {
    membership: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Snapshots, so past committees still read correctly after a member leaves.
    name: { type: String, required: true, trim: true },
    unitLabel: { type: String, trim: true },
    position: { type: String, enum: POSITIONS, required: true },
    title: { type: String, trim: true }, // optional display title, e.g. "Joint Secretary (B wing)"
    isSignatory: { type: Boolean, default: false },
    from: String, // YYYY-MM-DD
    to: String,
    active: { type: Boolean, default: true }, // false once the holder steps down mid-term
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

const termSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true }, // "Managing Committee 2026-2031"
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    status: { type: String, enum: ['upcoming', 'active', 'dissolved'], default: 'upcoming' },
    notes: { type: String, trim: true },
    positions: { type: [positionSchema], default: [] },
    activatedAt: Date,
    dissolvedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    source: { election: { type: mongoose.Schema.Types.ObjectId, ref: 'Election' } }, // set when seated from an election
  },
  { timestamps: true },
);
termSchema.index({ society: 1, startDate: -1 });
// Only one sitting committee per society.
termSchema.index({ society: 1 }, { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_term' });
termSchema.index({ society: 1, 'positions.user': 1 });

export default mongoose.model('CommitteeTerm', termSchema);
