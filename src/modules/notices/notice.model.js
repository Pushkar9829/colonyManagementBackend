import mongoose from 'mongoose';

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

const noticeSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    category: { type: String, enum: ['general', 'maintenance', 'event', 'meeting', 'emergency'], default: 'general' },
    audience: {
      type: { type: String, enum: ['all', 'blocks', 'roles'], default: 'all' },
      blocks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Block' }],
      roles: [String],
    },
    pinned: { type: Boolean, default: false },
    expiresAt: Date,
    attachments: [attachmentSchema],
    // also delivered by email when published
    sendEmail: { type: Boolean, default: false },
    // residents must explicitly confirm "I've read this"; managers track who hasn't
    requiresAck: { type: Boolean, default: false },
    acks: [{ _id: false, user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: { type: Date, default: Date.now } }],
    // null = visible immediately; a future time keeps it hidden from the audience until then
    publishAt: Date,
    // set once the audience has been notified (immediately, or by the scheduled-publish job)
    notifiedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true },
);
noticeSchema.index({ society: 1, pinned: -1, createdAt: -1 });
noticeSchema.index({ notifiedAt: 1, publishAt: 1 });

export default mongoose.model('Notice', noticeSchema);
