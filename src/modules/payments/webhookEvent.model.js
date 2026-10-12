import mongoose from 'mongoose';

// Provider webhook deliveries already processed. Providers retry deliveries, so each event id is
// handled once. Kept for 30 days.
const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    event: { type: String, required: true },
    handled: { type: String }, // what the event matched: bill, amenity, event, subscription, mandate, …
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 86400 });

export default mongoose.model('WebhookEvent', webhookEventSchema);
