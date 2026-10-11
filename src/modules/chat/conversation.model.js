import mongoose from 'mongoose';

// A 1:1 thread. `direct` = two members; `desk` = one member and a shared desk
// (security = every guard, management = admins + facility managers), so any agent on duty can answer.
//
// Per-side state lives in maps keyed by side: the user id for people, 'desk' for the desk side.
const conversationSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    kind: { type: String, enum: ['direct', 'desk'], required: true },
    // dedupe key: "direct:<idA>:<idB>" (sorted) or "desk:<desk>:<memberId>"
    key: { type: String, required: true },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    desk: { type: String, enum: ['security', 'management'] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastMessage: {
      text: String,
      sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      asDesk: Boolean,
      hasAttachment: Boolean,
    },
    lastMessageAt: Date,
    unread: { type: Map, of: Number, default: {} },
    readAt: { type: Map, of: Date, default: {} },
  },
  { timestamps: true },
);
conversationSchema.index({ society: 1, key: 1 }, { unique: true });
conversationSchema.index({ society: 1, participants: 1, lastMessageAt: -1 });
conversationSchema.index({ society: 1, kind: 1, desk: 1, lastMessageAt: -1 });

export default mongoose.model('Conversation', conversationSchema);
