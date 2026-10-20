import mongoose from 'mongoose';

// A member's opt-in directory listing and privacy choices for one society.
// Everything defaults to hidden: nobody appears in the directory until they opt in.
const directoryProfileSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    listed: { type: Boolean, default: false }, // name + flat shown to neighbours
    showPhone: { type: Boolean, default: false },
    showEmail: { type: Boolean, default: false },
    showProfession: { type: Boolean, default: false },
    // Personal details (modules/people): birthday shows day + month only, never the year.
    // showBirthday also puts the person on the society's "Today's birthdays" card.
    showBirthday: { type: Boolean, default: false },
    showOccupation: { type: Boolean, default: false },
    profession: { type: String, trim: true, maxlength: 80 },
    skills: [{ type: String, trim: true, maxlength: 40 }],
    about: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true },
);
directoryProfileSchema.index({ society: 1, user: 1 }, { unique: true });
directoryProfileSchema.index({ society: 1, listed: 1 });

export default mongoose.model('DirectoryProfile', directoryProfileSchema);
