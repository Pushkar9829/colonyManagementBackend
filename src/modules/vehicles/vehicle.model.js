import mongoose from 'mongoose';

const vehicleSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    number: { type: String, required: true, trim: true, uppercase: true },
    type: { type: String, enum: ['two_wheeler', 'four_wheeler', 'other'], default: 'four_wheeler' },
    make: { type: String, trim: true },
    color: { type: String, trim: true },
    parkingSlot: { type: String, trim: true },
    fuel: { type: String, enum: ['petrol', 'diesel', 'cng', 'electric', 'other'] },
    // RFID windshield tag issued by the society (read by gate readers).
    rfidTag: { type: String, trim: true, uppercase: true },
  },
  { timestamps: true },
);
vehicleSchema.index({ society: 1, number: 1 }, { unique: true });
vehicleSchema.index({ society: 1, unit: 1 });
vehicleSchema.index({ society: 1, rfidTag: 1 }, { unique: true, partialFilterExpression: { rfidTag: { $type: 'string' } } });

export default mongoose.model('Vehicle', vehicleSchema);
