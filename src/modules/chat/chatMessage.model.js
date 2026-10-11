import mongoose from 'mongoose';

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

const chatMessageSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // sent by an agent answering as the security / management desk
    asDesk: { type: Boolean, default: false },
    text: { type: String, trim: true, default: '' },
    attachments: [attachmentSchema],
    // what the message is about, e.g. a marketplace listing ("Is this still available?")
    context: {
      type: { type: String, enum: ['listing', 'lostFound', 'business'] },
      id: mongoose.Schema.Types.ObjectId,
      title: String,
    },
  },
  { timestamps: true },
);
chatMessageSchema.index({ society: 1, conversation: 1, createdAt: -1 });

export default mongoose.model('ChatMessage', chatMessageSchema);
