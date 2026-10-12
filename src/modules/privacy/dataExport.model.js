import mongoose from 'mongoose';

// When a person downloaded their own data: enforces the export cooldown and is the accountability record.
// Personal (not per society), because one export covers every society the person belongs to.
const dataExportSchema = new mongoose.Schema(
  { user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true } },
  { timestamps: { createdAt: true, updatedAt: false } },
);
dataExportSchema.index({ user: 1, createdAt: -1 });
dataExportSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

export default mongoose.model('DataExport', dataExportSchema);
