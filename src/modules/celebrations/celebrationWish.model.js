import mongoose from 'mongoose';

// One row per wish sent. The unique index is what makes the daily job idempotent: a person gets one
// birthday wish and one anniversary wish per year, however often the job runs or how many servers run it.
const celebrationWishSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    kind: { type: String, enum: ['birthday', 'anniversary'], required: true },
    personKey: { type: String, required: true }, // "user:<id>" or "member:<household member id>"
    year: { type: Number, required: true },
    date: String, // YYYY-MM-DD (IST) it was sent for
    name: String,
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    channels: [String], // what actually went out, e.g. ['inapp', 'push', 'whatsapp:sent']
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
celebrationWishSchema.index({ society: 1, kind: 1, personKey: 1, year: 1 }, { unique: true });
celebrationWishSchema.index({ society: 1, date: 1 });

export default mongoose.model('CelebrationWish', celebrationWishSchema);
