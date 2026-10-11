import mongoose from 'mongoose';
import { ALL_ROLES } from '../../common/constants/index.js';

const { ObjectId } = mongoose.Schema.Types;

// all: every member · committee: admins + sitting office-bearers · admins: society admins only
// roles: admins plus the listed roles
export const VISIBILITY = ['all', 'committee', 'admins', 'roles'];

const versionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true },
    url: { type: String, required: true },
    mimetype: String,
    name: String,
    note: { type: String, trim: true },
    uploadedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: 'uploadedAt', updatedAt: false } },
);

const documentSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    folder: { type: ObjectId, ref: 'DocumentFolder', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    tags: [{ type: String, trim: true, lowercase: true }],
    visibility: {
      type: { type: String, enum: VISIBILITY, default: 'all' },
      roles: [{ type: String, enum: ALL_ROLES }],
    },
    currentVersion: { type: Number, default: 1 },
    versions: { type: [versionSchema], default: [] },
    expiryDate: String, // YYYY-MM-DD, e.g. insurance policy end
    remindDaysBefore: { type: Number, default: 30, min: 0, max: 365 },
    lastReminderAt: Date,
    downloads: { type: Number, default: 0 },
    archived: { type: Boolean, default: false },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
documentSchema.index({ society: 1, folder: 1, archived: 1, updatedAt: -1 });
documentSchema.index({ society: 1, tags: 1 });
documentSchema.index({ society: 1, expiryDate: 1 });

export default mongoose.model('LibraryDocument', documentSchema);
