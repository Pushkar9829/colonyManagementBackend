import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;
const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

// `removed` = hidden by a moderator (kept for the audit trail); `deleted` = withdrawn by the author.
const topicSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    category: { type: ObjectId, ref: 'ForumCategory', required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    attachments: [attachmentSchema],
    author: { type: ObjectId, ref: 'User', required: true },
    mentions: [{ type: ObjectId, ref: 'User' }],
    pinned: { type: Boolean, default: false },
    locked: { type: Boolean, default: false },
    resolved: { type: Boolean, default: false },
    resolvedAt: Date,
    likes: [{ type: ObjectId, ref: 'User' }],
    likeCount: { type: Number, default: 0 },
    replyCount: { type: Number, default: 0 },
    lastActivityAt: { type: Date, default: Date.now },
    editedAt: Date,
    status: { type: String, enum: ['visible', 'removed', 'deleted'], default: 'visible' },
    removedReason: String,
  },
  { timestamps: true },
);
topicSchema.index({ society: 1, status: 1, pinned: -1, lastActivityAt: -1 });
topicSchema.index({ society: 1, category: 1, lastActivityAt: -1 });

export default mongoose.model('ForumTopic', topicSchema);
