import mongoose from 'mongoose';

const photoSchema = new mongoose.Schema({ url: String, mimetype: String, name: String });

const amenitySchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    rules: { type: String, trim: true },
    capacity: { type: Number, min: 1, default: 1 }, // parallel bookings allowed per slot
    openTime: { type: String, default: '06:00' }, // HH:MM
    closeTime: { type: String, default: '22:00' },
    slotMinutes: { type: Number, default: 60, min: 15 },
    maxBookingsPerUnitPerDay: { type: Number, default: 1, min: 1 },
    advanceDays: { type: Number, default: 30, min: 0 },
    requiresApproval: { type: Boolean, default: false },
    fee: { type: Number, default: 0, min: 0 }, // paise per slot
    deposit: { type: Number, default: 0, min: 0 }, // refundable paise per booking, returned after the event
    // online: booking is held until paid through the gateway; desk: confirmed now, paid at the office
    paymentMode: { type: String, enum: ['online', 'desk'], default: 'online' },
    // Fee refund on cancellation by the resident: full refund up to fullRefundHours before the start,
    // partialRefundPercent up to partialRefundHours before, nothing after. Deposits are always returned.
    cancellation: {
      fullRefundHours: { type: Number, default: 24, min: 0 },
      partialRefundHours: { type: Number, default: 6, min: 0 },
      partialRefundPercent: { type: Number, default: 50, min: 0, max: 100 },
    },
    photos: { type: [photoSchema], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
amenitySchema.index({ society: 1, name: 1 }, { unique: true });

export default mongoose.model('Amenity', amenitySchema);
