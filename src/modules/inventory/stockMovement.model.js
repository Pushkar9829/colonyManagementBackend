import mongoose from 'mongoose';

export const MOVEMENT_TYPES = ['in', 'out', 'adjust'];

const { ObjectId } = mongoose.Schema.Types;

// Append-only stock ledger. qty is signed (+ in, − out); balanceAfter is the stock right after this entry.
const stockMovementSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    item: { type: ObjectId, ref: 'InventoryItem', required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    qty: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    unitCost: { type: Number, min: 0, default: 0 }, // paise
    value: { type: Number, default: 0 }, // signed paise
    date: { type: String, required: true }, // YYYY-MM-DD
    // stock in
    vendor: { type: ObjectId, ref: 'Vendor' },
    vendorName: { type: String, trim: true },
    invoiceNumber: { type: String, trim: true },
    // stock out
    issuedTo: { type: ObjectId, ref: 'User' },
    ppmTask: { type: ObjectId, ref: 'PpmTask' },
    workOrder: { type: ObjectId, ref: 'WorkOrder' },
    location: { type: String, trim: true },
    reason: { type: String, trim: true },
    by: { type: ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
stockMovementSchema.index({ society: 1, item: 1, createdAt: -1 });
stockMovementSchema.index({ society: 1, date: -1 });

export default mongoose.model('StockMovement', stockMovementSchema);
