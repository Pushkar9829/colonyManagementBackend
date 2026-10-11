import mongoose from 'mongoose';

// A day a helper is away. 'household' entries are marked by a home (planned leave or "didn't come");
// 'auto' entries are written by the noon job when the gate saw no entry (unit is empty then).
const helpLeaveSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    help: { type: mongoose.Schema.Types.ObjectId, ref: 'DailyHelp', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
    date: { type: String, required: true }, // YYYY-MM-DD
    kind: { type: String, enum: ['leave', 'absent'], default: 'leave' },
    source: { type: String, enum: ['household', 'auto'], default: 'household' },
    reason: { type: String, trim: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
helpLeaveSchema.index({ society: 1, help: 1, date: 1, unit: 1 }, { unique: true });
helpLeaveSchema.index({ society: 1, date: 1 });

export default mongoose.model('HelpLeave', helpLeaveSchema);
