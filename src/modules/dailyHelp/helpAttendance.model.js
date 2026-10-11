import mongoose from 'mongoose';

const helpAttendanceSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    help: { type: mongoose.Schema.Types.ObjectId, ref: 'DailyHelp', required: true },
    inAt: { type: Date, required: true },
    outAt: Date,
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
helpAttendanceSchema.index({ society: 1, help: 1, inAt: -1 });

export default mongoose.model('HelpAttendance', helpAttendanceSchema);
