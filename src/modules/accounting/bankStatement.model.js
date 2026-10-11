import mongoose from 'mongoose';

const importSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    code: { type: String, required: true }, // bank account code
    fileName: { type: String, trim: true },
    rows: { type: Number, default: 0 },
    imported: { type: Number, default: 0 },
    duplicates: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    from: String,
    to: String,
    autoMatched: { type: Number, default: 0 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
importSchema.index({ society: 1, code: 1, createdAt: -1 });

// One line of an imported bank statement, seen from the bank's side:
// deposit = money into the account (our debit), withdrawal = money out (our credit).
const lineSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    code: { type: String, required: true },
    import: { type: mongoose.Schema.Types.ObjectId, ref: 'BankStatementImport' },
    date: { type: String, required: true }, // YYYY-MM-DD
    description: { type: String, trim: true },
    reference: { type: String, trim: true },
    deposit: { type: Number, default: 0, min: 0 },
    withdrawal: { type: Number, default: 0, min: 0 },
    balance: { type: Number }, // running balance printed on the statement, when present
    hash: { type: String, required: true }, // dedupe key so re-importing a statement adds nothing
    status: { type: String, enum: ['unmatched', 'matched', 'ignored'], default: 'unmatched' },
    matchType: { type: String, enum: ['auto', 'manual', 'created'] },
    // Journal lines on this bank account that this statement line clears (usually one; a single
    // deposit can clear several receipts).
    entries: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' }], default: undefined },
    entryLines: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
    matchedAt: Date,
    matchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
lineSchema.index({ society: 1, code: 1, hash: 1 }, { unique: true });
lineSchema.index({ society: 1, code: 1, status: 1, date: 1 });
lineSchema.index({ society: 1, entryLines: 1 });

export const BankStatementImport = mongoose.model('BankStatementImport', importSchema);
export const BankStatementLine = mongoose.model('BankStatementLine', lineSchema);
