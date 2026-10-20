import mongoose from 'mongoose';

// What a message was about, for the per-type usage breakdown.
export const MESSAGE_KINDS = ['bill', 'receipt', 'reminder', 'sos', 'wishes', 'notice', 'other'];
export const LEDGER_ENTRIES = ['grant', 'debit', 'refund'];

// Append-only credit ledger. grant (+n, platform top-up), debit (-1 per message), refund (+1 when the
// provider rejected a message we had already paid for). The account balance is the running sum.
const whatsappCreditSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    entry: { type: String, enum: LEDGER_ENTRIES, required: true },
    amount: { type: Number, required: true }, // signed
    kind: { type: String, enum: MESSAGE_KINDS },
    balanceAfter: Number,
    note: { type: String, trim: true, maxlength: 300 },
    to: String, // masked recipient, e.g. ******4821
    ref: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppCredit' }, // refund -> its debit
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // platform member who granted
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
whatsappCreditSchema.index({ society: 1, createdAt: -1 });
whatsappCreditSchema.index({ society: 1, entry: 1, createdAt: -1 });

export default mongoose.model('WhatsAppCredit', whatsappCreditSchema);
