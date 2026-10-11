import mongoose from 'mongoose';
import { BILLING_CYCLES, PLAN_NAMES } from './subscriptions.constants.js';

const lineSchema = new mongoose.Schema({ description: { type: String, required: true }, amount: { type: Number, required: true } }, { _id: false });
const reminderSchema = new mongoose.Schema({ stage: String, at: Date }, { _id: false });

// Invoice raised by the platform to a society (amounts in paise, GST on top of the subtotal).
const platformInvoiceSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true, unique: true }, // PINV-000001, platform-wide
    plan: { type: String, enum: PLAN_NAMES, required: true },
    billingCycle: { type: String, enum: BILLING_CYCLES, required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true }, // exclusive
    months: { type: Number, required: true },
    units: { type: Number, default: 0 },
    perUnitMonthly: { type: Number, default: 0 },
    flatMonthly: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
    lines: { type: [lineSchema], default: [] },
    subtotal: { type: Number, required: true, min: 0 },
    gstRate: { type: Number, required: true },
    gst: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: ['unpaid', 'paid', 'void'], default: 'unpaid' },
    paidAt: Date,
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPayment' },
    // Unguessable link token so a suspended society (whose members cannot open it) can still pay.
    payToken: { type: String, required: true, select: false },
    reminders: { type: [reminderSchema], default: [] },
    lastReminderAt: Date,
    voidReason: String,
    notes: String,
  },
  { timestamps: true },
);
platformInvoiceSchema.index({ society: 1, periodStart: 1 }, { unique: true });
platformInvoiceSchema.index({ society: 1, createdAt: -1 });
platformInvoiceSchema.index({ status: 1, dueDate: 1 });
platformInvoiceSchema.index({ payToken: 1 }, { unique: true });

export default mongoose.model('PlatformInvoice', platformInvoiceSchema);
