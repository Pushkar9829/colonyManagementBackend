import mongoose from 'mongoose';
import { BOOKING_STATUS } from '../../common/constants/index.js';

// payment_pending: slot held until paymentDueAt while the resident pays online.
export const BOOKING_STATUSES = [...BOOKING_STATUS, 'payment_pending'];
export const PAYMENT_STATUSES = ['not_required', 'pending', 'pay_at_desk', 'paid', 'refunded', 'partially_refunded'];
export const DEPOSIT_STATUSES = ['none', 'due', 'held', 'refunded', 'partially_refunded', 'forfeited'];

const bookingSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    amenity: { type: mongoose.Schema.Types.ObjectId, ref: 'Amenity', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD (society local date)
    startTime: { type: String, required: true }, // HH:MM
    endTime: { type: String, required: true },
    guests: { type: Number, default: 1, min: 1 },
    notes: { type: String, trim: true },
    // set when the slot is reserved for a society event (events/venue.js); such bookings move with the event
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
    fee: { type: Number, default: 0 }, // paise
    deposit: { type: Number, default: 0 }, // paise, refundable
    status: { type: String, enum: BOOKING_STATUSES, default: 'confirmed' },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'not_required' },
    paymentDueAt: Date,
    depositStatus: { type: String, enum: DEPOSIT_STATUSES, default: 'none' },
    depositRefunded: { type: Number, default: 0 },
    depositNote: String, // reason for any deduction
    feeRefunded: { type: Number, default: 0 },
    cancelledAt: Date,
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelReason: String,
    attendance: { type: String, enum: ['attended', 'no_show'] },
    attendanceMarkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decisionNote: String,
  },
  { timestamps: true },
);
bookingSchema.index({ society: 1, amenity: 1, date: 1, status: 1 });
bookingSchema.index({ society: 1, user: 1, date: -1 });
bookingSchema.index({ status: 1, paymentDueAt: 1 });
bookingSchema.index({ society: 1, event: 1 });

export default mongoose.model('Booking', bookingSchema);
