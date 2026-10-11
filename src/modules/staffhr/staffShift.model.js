import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Shift template, e.g. "Day 08:00–20:00". end <= start means it runs past midnight.
const staffShiftSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    start: { type: String, required: true }, // HH:MM
    end: { type: String, required: true },
    color: { type: String, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
staffShiftSchema.index({ society: 1, name: 1 }, { unique: true });

export default mongoose.model('StaffShift', staffShiftSchema);
