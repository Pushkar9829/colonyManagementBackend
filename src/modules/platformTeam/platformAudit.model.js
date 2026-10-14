import mongoose from 'mongoose';

// Platform console activity: who did what, to which record, in which society. Append-only.
// Society-side admins still see platform changes to their society in their own AuditLog.
const platformAuditSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true }, // e.g. 'society.suspended', 'invoice.marked_paid'
  targetType: String, // 'Society', 'PlatformInvoice', 'SupportTicket', 'User', 'PlatformRole', ...
  targetId: { type: mongoose.Schema.Types.ObjectId },
  society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society' },
  details: { type: mongoose.Schema.Types.Mixed },
  ip: String,
  at: { type: Date, default: Date.now },
});
platformAuditSchema.index({ at: -1 });
platformAuditSchema.index({ actor: 1, at: -1 });
platformAuditSchema.index({ society: 1, at: -1 });
platformAuditSchema.index({ action: 1, at: -1 });

export default mongoose.model('PlatformAudit', platformAuditSchema);
