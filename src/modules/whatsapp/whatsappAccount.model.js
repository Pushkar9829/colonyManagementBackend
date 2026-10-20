import mongoose from 'mongoose';

// off           — no WhatsApp at all.
// click_to_chat — nothing is sent automatically; the app offers "Send on WhatsApp" (wa.me) buttons instead.
// api           — messages go out automatically through the WhatsApp provider, paid for with credits.
export const WHATSAPP_MODES = ['off', 'click_to_chat', 'api'];
export const DEFAULT_LOW_BALANCE = 50;

// One per society. Only the platform team changes mode and credits; societies without a row are 'off'.
const whatsappAccountSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    mode: { type: String, enum: WHATSAPP_MODES, default: 'off' },
    // Can go below zero: SOS alerts are still sent (and counted) after the credits run out.
    balance: { type: Number, default: 0 },
    lowBalanceThreshold: { type: Number, default: DEFAULT_LOW_BALANCE, min: 0 },
    // Admins are told once per dip; a top-up above the line clears these.
    lowNotifiedAt: Date,
    emptyNotifiedAt: Date,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
whatsappAccountSchema.index({ society: 1 }, { unique: true });

export default mongoose.model('WhatsAppAccount', whatsappAccountSchema);
