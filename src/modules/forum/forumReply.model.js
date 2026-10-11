import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const replySchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    topic: { type: ObjectId, ref: 'ForumTopic', required: true },
    author: { type: ObjectId, ref: 'User', required: true },
    body: { type: String, required: true },
    mentions: [{ type: ObjectId, ref: 'User' }],
    likes: [{ type: ObjectId, ref: 'User' }],
    likeCount: { type: Number, default: 0 },
    editedAt: Date,
    status: { type: String, enum: ['visible', 'removed', 'deleted'], default: 'visible' },
    removedReason: String,
  },
  { timestamps: true },
);
replySchema.index({ society: 1, topic: 1, createdAt: 1 });

export default mongoose.model('ForumReply', replySchema);
