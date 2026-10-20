import mongoose from 'mongoose';

// Platform switch per society: may the society run its own ads? No row = allowed.
const adSettingSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    allowSocietyAds: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
adSettingSchema.index({ society: 1 }, { unique: true });

export default mongoose.model('AdSetting', adSettingSchema);
