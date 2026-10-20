import mongoose from 'mongoose';
import { GENDERS, monthDay, occupationSchema } from './occupation.js';

// Birthday, anniversary, gender and occupation of a member with an app login, per society (the same person
// may share different details in another society). Family members without a login keep theirs on Household.
const personalDetailsSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    dateOfBirth: String, // YYYY-MM-DD (IST calendar date)
    anniversaryDate: String, // YYYY-MM-DD
    gender: { type: String, enum: GENDERS },
    occupation: { type: occupationSchema, default: undefined },
    // Derived "MM-DD" keys so the daily wishes job finds today's people with an index.
    birthMD: String,
    anniversaryMD: String,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
personalDetailsSchema.index({ society: 1, user: 1 }, { unique: true });
personalDetailsSchema.index({ birthMD: 1 });
personalDetailsSchema.index({ anniversaryMD: 1 });
personalDetailsSchema.index({ society: 1, 'occupation.working.category': 1 });

personalDetailsSchema.pre('save', async function derive() {
  this.birthMD = monthDay(this.dateOfBirth);
  this.anniversaryMD = monthDay(this.anniversaryDate);
});

export default mongoose.model('PersonalDetails', personalDetailsSchema);
