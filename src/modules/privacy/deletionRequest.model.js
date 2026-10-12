import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const DELETION_STATUS = ['pending', 'approved', 'rejected', 'cancelled'];

// A person's request to erase their account (DPDP Act 2023, s.12). One account can belong to several societies, so
// the request lists every society it touches and each one's admin approves; the account is anonymised once all have.
// With no society (e.g. a platform user, or someone whose memberships all ended) the platform owner decides.
// Unlike tenant documents this is keyed by person, so `societies` (not `society`) scopes who may see it.
const deletionRequestSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    userName: { type: String, trim: true }, // snapshot for the admin list; replaced once anonymised
    societies: [{ type: ObjectId, ref: 'Society' }],
    reason: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: DELETION_STATUS, default: 'pending' },
    approvals: [{ _id: false, society: { type: ObjectId, ref: 'Society' }, by: { type: ObjectId, ref: 'User' }, at: { type: Date, default: Date.now } }],
    decidedBy: { type: ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionNote: { type: String, trim: true, maxlength: 500 },
    completedAt: Date, // when the account was anonymised
    history: [
      {
        _id: false,
        action: { type: String, required: true },
        by: { type: ObjectId, ref: 'User' },
        society: { type: ObjectId, ref: 'Society' },
        note: String,
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);
deletionRequestSchema.index({ societies: 1, status: 1, createdAt: -1 });
deletionRequestSchema.index({ user: 1, createdAt: -1 });
// At most one open request per person.
deletionRequestSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_per_user' });

export default mongoose.model('DeletionRequest', deletionRequestSchema);
