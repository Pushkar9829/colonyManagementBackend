import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Money received for an event RSVP — either collected at the venue or paid online through the
// payment provider. Kept separate from maintenance Payments so event money never touches bills.
const eventTicketSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    event: { type: ObjectId, ref: 'Event', required: true },
    rsvp: { type: ObjectId, ref: 'EventRsvp', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 0 }, // paise
    method: { type: String, enum: ['online', 'cash', 'upi'], required: true },
    provider: String,
    providerOrderId: String,
    providerPaymentId: String,
    status: { type: String, enum: ['created', 'success', 'failed'], default: 'created' },
    receiptNumber: String,
    paidAt: Date,
    recordedBy: { type: ObjectId, ref: 'User' }, // organiser who collected at the venue
    notes: String,
  },
  { timestamps: true },
);
eventTicketSchema.index({ society: 1, event: 1, status: 1 });
eventTicketSchema.index({ society: 1, providerOrderId: 1 }, { unique: true, partialFilterExpression: { providerOrderId: { $type: 'string' } } });

export default mongoose.model('EventTicket', eventTicketSchema);
