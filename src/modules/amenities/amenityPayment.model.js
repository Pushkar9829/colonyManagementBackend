import mongoose from 'mongoose';

// Money collected for amenities, one record per kind: the booking fee and the refundable deposit are
// separate records (they can share one gateway order). Pass purchases are 'fee' records with `pass` set.
// Read by the accounting module — keep the field names stable. All amounts in integer paise.
const amenityPaymentSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    pass: { type: mongoose.Schema.Types.ObjectId, ref: 'AmenityPass' },
    amenity: { type: mongoose.Schema.Types.ObjectId, ref: 'Amenity' },
    kind: { type: String, enum: ['fee', 'deposit'], required: true },
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['created', 'success', 'failed', 'refunded'], default: 'created' },
    method: { type: String, enum: ['online', 'cash', 'upi', 'card', 'cheque', 'bank'], default: 'online' },
    provider: { type: String, default: 'offline' }, // 'mock' | 'razorpay' | 'offline'
    providerOrderId: String,
    providerPaymentId: String,
    reference: String, // receipt / UPI reference for desk payments
    refundedAmount: { type: Number, default: 0, min: 0 }, // a partial refund keeps status 'refunded' with refundedAmount < amount
    refundIds: { type: [String], default: [] },
    paidAt: Date,
    refundedAt: Date,
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: String,
  },
  { timestamps: true },
);
amenityPaymentSchema.index({ society: 1, providerOrderId: 1 });
amenityPaymentSchema.index({ society: 1, booking: 1 });
amenityPaymentSchema.index({ society: 1, pass: 1 });
amenityPaymentSchema.index({ society: 1, status: 1, paidAt: -1 });

export default mongoose.model('AmenityPayment', amenityPaymentSchema);
