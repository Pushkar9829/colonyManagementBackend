import mongoose from 'mongoose';

export const SUMMARY_SECTIONS = ['collections', 'dues', 'complaints', 'visitors'];

// A society's recurring summary email (with an Excel attachment), sent by the scheduled-reports job.
const reportScheduleSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    frequency: { type: String, enum: ['weekly', 'monthly'], required: true },
    sections: { type: [{ type: String, enum: SUMMARY_SECTIONS }], default: SUMMARY_SECTIONS },
    recipients: { type: [{ type: String, trim: true, lowercase: true }], default: [] }, // empty = all society admins
    enabled: { type: Boolean, default: true },
    nextRunAt: { type: Date, required: true },
    lastSentAt: Date,
    lastError: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
reportScheduleSchema.index({ society: 1, frequency: 1 }, { unique: true });
reportScheduleSchema.index({ enabled: 1, nextRunAt: 1 });

export default mongoose.model('ReportSchedule', reportScheduleSchema);
