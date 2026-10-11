import mongoose from 'mongoose';

export const COMMAND_STATUS = ['pending', 'sent', 'done', 'failed', 'expired'];

// "Open barrier" pressed by a guard; the barrier controller polls for it and acknowledges.
// Commands expire quickly so a controller that was offline does not open the gate minutes later.
const barrierCommandSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    gate: { type: String, required: true, trim: true },
    action: { type: String, enum: ['open', 'close'], default: 'open' },
    reason: { type: String, trim: true },
    visitor: { type: mongoose.Schema.Types.ObjectId, ref: 'Visitor' },
    movement: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleMovement' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: COMMAND_STATUS, default: 'pending' },
    expiresAt: { type: Date, required: true },
    sentAt: Date,
    sentTo: { type: mongoose.Schema.Types.ObjectId, ref: 'DeviceKey' },
    ackedAt: Date,
    ackedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'DeviceKey' },
    ackMessage: { type: String, trim: true },
  },
  { timestamps: true },
);
barrierCommandSchema.index({ society: 1, status: 1, gate: 1, createdAt: 1 });
barrierCommandSchema.index({ society: 1, createdAt: -1 });

export default mongoose.model('BarrierCommand', barrierCommandSchema);
