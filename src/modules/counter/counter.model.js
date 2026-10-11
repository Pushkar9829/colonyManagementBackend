import mongoose from 'mongoose';

// Per-society atomic sequences for human-readable numbers (tickets, bills, receipts).
const counterSchema = new mongoose.Schema({
  society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ society: 1, key: 1 }, { unique: true });

export default mongoose.model('Counter', counterSchema);
