import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// HR settings per society (one document). Kept here rather than on Society, which another module owns.
const staffhrSettingsSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true, unique: true },
    geofence: {
      enabled: { type: Boolean, default: false },
      lat: Number,
      lng: Number,
      radiusM: { type: Number, min: 20, max: 5000, default: 200 },
    },
    requireSelfie: { type: Boolean, default: true },
    lateGraceMinutes: { type: Number, min: 0, max: 240, default: 15 },
    halfDayMinutes: { type: Number, min: 0, max: 720, default: 240 }, // worked less than this → half day
    leaveQuota: {
      casual: { type: Number, min: 0, max: 60, default: 12 },
      sick: { type: Number, min: 0, max: 60, default: 7 },
      earned: { type: Number, min: 0, max: 60, default: 15 },
    },
    // statutory wage ceilings, paise per month
    pfWageCeiling: { type: Number, min: 0, default: 1500000 },
    esiWageCeiling: { type: Number, min: 0, default: 2100000 },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export default mongoose.model('StaffhrSettings', staffhrSettingsSchema);
