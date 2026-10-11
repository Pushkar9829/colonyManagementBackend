import mongoose from 'mongoose';

const lineSchema = new mongoose.Schema({
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  code: { type: String, required: true }, // denormalised account code: reports group on it
  debit: { type: Number, default: 0, min: 0 }, // paise
  credit: { type: Number, default: 0, min: 0 },
  unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
  memo: { type: String, trim: true },
});

// Posted entries are never edited or deleted; mistakes are corrected with a reversing entry.
const journalEntrySchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true }, // JV-000001
    date: { type: String, required: true }, // YYYY-MM-DD (IST)
    narration: { type: String, required: true, trim: true },
    reference: { type: String, trim: true }, // UTR / cheque no. — helps bank matching
    kind: { type: String, enum: ['manual', 'auto', 'opening', 'reversal'], default: 'manual' },
    // Idempotency key for automatic postings: one entry per (sourceType, sourceId) per society.
    sourceType: { type: String },
    sourceId: { type: String },
    sourceRef: { type: String }, // id of the source document (several entries can share one, e.g. bill + late fees)
    lines: { type: [lineSchema], validate: [(v) => v.length >= 2, 'An entry needs at least two lines'] },
    total: { type: Number, required: true, min: 1 }, // sum of debits (= sum of credits)
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' },
    reversalReason: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
journalEntrySchema.index({ society: 1, number: 1 }, { unique: true });
journalEntrySchema.index({ society: 1, date: -1, number: -1 });
journalEntrySchema.index({ society: 1, 'lines.code': 1, date: 1 });
journalEntrySchema.index({ society: 1, sourceRef: 1 });
journalEntrySchema.index(
  { society: 1, sourceType: 1, sourceId: 1 },
  { unique: true, partialFilterExpression: { sourceId: { $type: 'string' } } },
);

export default mongoose.model('JournalEntry', journalEntrySchema);
