import mongoose from 'mongoose';

// Which levels may use "Log in as". The row with society null is the platform-wide rule; a row per society
// overrides it (a null field there means "same as the platform rule").
const loginAsPolicySchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', default: null },
    platform: { type: Boolean, default: null }, // platform team -> anyone in the society
    admin: { type: Boolean, default: null }, // society admin -> sub-admins, guards, residents, staff
    subadmin: { type: Boolean, default: null }, // accountant / facility manager -> guards, residents, staff
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
loginAsPolicySchema.index({ society: 1 }, { unique: true });

export default mongoose.model('LoginAsPolicy', loginAsPolicySchema);
