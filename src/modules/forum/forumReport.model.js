import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const reportSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    targetType: { type: String, enum: ['topic', 'reply'], required: true },
    target: { type: ObjectId, required: true },
    topic: { type: ObjectId, ref: 'ForumTopic', required: true },
    reporter: { type: ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: ['spam', 'abusive', 'harassment', 'off_topic', 'misinformation', 'other'], required: true },
    note: { type: String, trim: true },
    status: { type: String, enum: ['open', 'dismissed', 'actioned'], default: 'open' },
    resolvedBy: { type: ObjectId, ref: 'User' },
    resolvedAt: Date,
  },
  { timestamps: true },
);
reportSchema.index({ society: 1, target: 1, reporter: 1 }, { unique: true });
reportSchema.index({ society: 1, status: 1, createdAt: -1 });

export default mongoose.model('ForumReport', reportSchema);
