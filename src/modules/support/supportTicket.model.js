import mongoose from 'mongoose';

export const SUPPORT_CATEGORIES = ['billing', 'technical', 'account', 'feature_request', 'data', 'training', 'other'];
export const SUPPORT_PRIORITY = ['low', 'medium', 'high', 'urgent'];
export const SUPPORT_STATUS = ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'];
export const SUPPORT_ACTIVE = ['open', 'in_progress', 'waiting_on_customer'];
// Hours for the platform team's first response.
export const SUPPORT_SLA_HOURS = { urgent: 4, high: 8, medium: 24, low: 48 };

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

const messageSchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    side: { type: String, enum: ['society', 'platform'], required: true },
    text: { type: String, required: true, trim: true },
    attachments: { type: [attachmentSchema], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const historySchema = new mongoose.Schema({ by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, from: String, to: String, note: String }, { _id: false, timestamps: { createdAt: true, updatedAt: false } });

// A ticket a society raises with the platform team (not a resident complaint).
const supportTicketSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true, unique: true }, // SUP-000001, platform-wide
    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    raisedByRole: { type: String },
    category: { type: String, enum: SUPPORT_CATEGORIES, required: true },
    priority: { type: String, enum: SUPPORT_PRIORITY, default: 'medium' },
    subject: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    attachments: { type: [attachmentSchema], default: [] },
    status: { type: String, enum: SUPPORT_STATUS, default: 'open' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // platform team member
    slaDueAt: Date, // first response due
    firstResponseAt: Date,
    slaEscalatedAt: Date,
    resolvedAt: Date,
    closedAt: Date,
    // Who has to act next; drives the "needs reply" badges on both sides.
    awaiting: { type: String, enum: ['platform', 'society', 'none'], default: 'platform' },
    lastActivityAt: { type: Date, default: Date.now },
    messages: { type: [messageSchema], default: [] },
    history: { type: [historySchema], default: [] },
    rating: { type: Number, min: 1, max: 5 },
  },
  { timestamps: true },
);
supportTicketSchema.index({ society: 1, status: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, priority: 1, lastActivityAt: -1 });
supportTicketSchema.index({ status: 1, slaDueAt: 1 });

export default mongoose.model('SupportTicket', supportTicketSchema);
