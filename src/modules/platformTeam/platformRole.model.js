import mongoose from 'mongoose';

// A named set of platform console permissions (modules/platformTeam/permissions.js). Not tenant data:
// the platform team works across every society.
const platformRoleSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true }, // system roles only: 'owner', 'admin', 'billing', ...
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 300 },
    permissions: { type: [String], default: [] },
    system: { type: Boolean, default: false }, // built in; cannot be edited or deleted
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

platformRoleSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
platformRoleSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export default mongoose.model('PlatformRole', platformRoleSchema);
