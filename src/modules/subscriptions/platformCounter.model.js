import mongoose from 'mongoose';

// Platform-wide sequences (PINV-, SUP-). The core Counter is per society; these numbers are not.
const platformCounterSchema = new mongoose.Schema({ _id: { type: String }, seq: { type: Number, default: 0 } });

const PlatformCounter = mongoose.model('PlatformCounter', platformCounterSchema);

export async function nextPlatformNumber(key, prefix, pad = 6) {
  const doc = await PlatformCounter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true });
  return `${prefix}-${String(doc.seq).padStart(pad, '0')}`;
}

export default PlatformCounter;
