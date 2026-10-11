import mongoose from 'mongoose';
import { ALL_ROLES, RESIDENT_TYPES, USER_STATUS } from '../../common/constants/index.js';

// A user's place in one society: their role and (for residents) their flat.
// One person can hold several — e.g. owner of A-101 and A-102, or resident here and committee admin elsewhere.
const membershipSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    role: { type: String, enum: ALL_ROLES, required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    residentType: { type: String, enum: RESIDENT_TYPES },
    designation: { type: String, trim: true }, // Secretary, Treasurer, Plumber...
    status: { type: String, enum: USER_STATUS, default: 'active' },
    // Temporary platform-support access (see auth/sessions.service.js). Hidden from member lists.
    support: { type: Boolean, default: false },
    expiresAt: Date,
  },
  { timestamps: true },
);

// One membership per (person, society, flat). Staff roles have no flat, so at most one staff role per society.
membershipSchema.index({ user: 1, society: 1, unit: 1 }, { unique: true });
membershipSchema.index({ society: 1, role: 1, status: 1 });
membershipSchema.index({ society: 1, unit: 1, status: 1 });

export default mongoose.model('Membership', membershipSchema);
