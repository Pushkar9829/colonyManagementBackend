import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// One per (event, member). `state` is what counts for capacity:
//   confirmed  - has seats (headcount counted in Event.goingCount)
//   waitlisted - said yes but the event was full; promoted in order when seats free up
//   maybe / declined - no seats held
//   cancelled  - the event itself was cancelled
const eventRsvpSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    event: { type: ObjectId, ref: 'Event', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    unit: { type: ObjectId, ref: 'Unit' },
    response: { type: String, enum: ['yes', 'maybe', 'no'], required: true },
    guests: { type: Number, min: 0, default: 0 },
    headcount: { type: Number, min: 1, default: 1 },
    state: { type: String, enum: ['confirmed', 'waitlisted', 'maybe', 'declined', 'cancelled'], required: true },
    waitlistedAt: Date,
    // paid events: amount = headcount x ticket price
    amountDue: { type: Number, min: 0, default: 0 },
    paymentMode: { type: String, enum: ['none', 'venue', 'online'], default: 'none' },
    paymentStatus: { type: String, enum: ['not_required', 'pending', 'paid', 'refund_due'], default: 'not_required' },
    ticketCode: { type: String, required: true }, // shown as a QR code on the ticket
    checkedInAt: Date,
    checkedInBy: { type: ObjectId, ref: 'User' },
    attendedCount: Number,
  },
  { timestamps: true },
);
eventRsvpSchema.index({ society: 1, event: 1, user: 1 }, { unique: true });
eventRsvpSchema.index({ society: 1, event: 1, state: 1, waitlistedAt: 1 });
eventRsvpSchema.index({ society: 1, ticketCode: 1 }, { unique: true });

export default mongoose.model('EventRsvp', eventRsvpSchema);
