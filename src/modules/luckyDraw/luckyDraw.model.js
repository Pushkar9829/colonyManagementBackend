import mongoose from 'mongoose';

// Society lucky draws. Entry is always FREE: there are deliberately no fee / payment fields anywhere in this
// module. Charging for a chance to win a prize would make this a lottery, which in India is regulated
// (Lotteries (Regulation) Act, 1998 and state laws) and cannot be run by a housing society. Keep it free.

export const DRAW_STATUS = ['draft', 'open', 'closed', 'drawn', 'cancelled'];
export const AUDIENCES = ['all_residents', 'owners', 'tenants'];

const { ObjectId, Mixed } = mongoose.Schema.Types;
const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

const prizeSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  quantity: { type: Number, required: true, min: 1, max: 100 },
  value: { type: String, trim: true }, // display text only, e.g. "Worth ₹45,000"
});

// One prize slot. A slot whose winner turned out ineligible is marked `replaced` and a reserve takes a new slot.
const winnerSchema = new mongoose.Schema({
  entry: { type: ObjectId, ref: 'LuckyDrawEntry', required: true },
  user: { type: ObjectId, ref: 'User', required: true },
  unit: { type: ObjectId, ref: 'Unit' },
  name: String,
  unitLabel: String,
  position: { type: Number, required: true }, // rank in the fair order (1 = first drawn)
  status: { type: String, enum: ['won', 'replaced'], default: 'won' },
  promotedFrom: ObjectId, // the replaced winner slot this reserve took over
  replacedAt: Date,
  replacedBy: { type: ObjectId, ref: 'User' },
  replacedReason: String,
  handedOverAt: Date,
  handedOverBy: { type: ObjectId, ref: 'User' },
  handoverNote: String,
});

const reserveSchema = new mongoose.Schema({
  entry: { type: ObjectId, ref: 'LuckyDrawEntry', required: true },
  user: { type: ObjectId, ref: 'User', required: true },
  unit: { type: ObjectId, ref: 'Unit' },
  name: String,
  unitLabel: String,
  position: { type: Number, required: true },
  usedFor: ObjectId, // prize id once promoted
  usedAt: Date,
});

const luckyDrawSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true }, // LD-000001
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    coverImage: attachmentSchema,
    terms: { type: String, trim: true },
    prizes: { type: [prizeSchema], default: [] },
    eligibility: {
      audience: { type: String, enum: AUDIENCES, default: 'all_residents' },
      perFlat: { type: Boolean, default: false }, // one entry per flat instead of per member
      excludeCommittee: { type: Boolean, default: false },
    },
    entryOpensAt: { type: Date, required: true },
    entryClosesAt: { type: Date, required: true },
    drawAt: { type: Date, required: true },
    reserves: { type: Number, default: 0, min: 0, max: 10 },
    status: { type: String, enum: DRAW_STATUS, default: 'draft' },
    createdBy: { type: ObjectId, ref: 'User' },
    publishedAt: Date,
    closedAt: Date,
    // Commit-reveal: seedHash is published when the draw opens, the seed itself only after the draw,
    // so nobody (admins included) can pick a seed that favours someone once the entries are known.
    fairness: {
      seedHash: String,
      seed: { type: String, select: false },
      algorithm: String,
      entriesHash: String,
      entryCount: Number,
    },
    results: [{ prize: ObjectId, title: String, winners: [winnerSchema] }],
    reservesList: { type: [reserveSchema], default: [] },
    noEntrants: { type: Boolean, default: false },
    drawnAt: Date,
    drawnBy: Mixed, // 'scheduler' or the user id who pressed "Run draw now"
    reminderSentAt: Date,
    cancelledAt: Date,
    cancelledBy: { type: ObjectId, ref: 'User' },
    cancelledReason: String,
  },
  { timestamps: true, optimisticConcurrency: true },
);
luckyDrawSchema.index({ society: 1, number: 1 }, { unique: true });
luckyDrawSchema.index({ society: 1, status: 1, entryClosesAt: -1 });
luckyDrawSchema.index({ status: 1, entryClosesAt: 1 }); // scheduler
luckyDrawSchema.index({ status: 1, drawAt: 1 }); // scheduler

export default mongoose.model('LuckyDraw', luckyDrawSchema);
