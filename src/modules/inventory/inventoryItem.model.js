import mongoose from 'mongoose';

export const ITEM_CATEGORIES = ['electrical', 'plumbing', 'cleaning', 'chemical', 'spare_part', 'consumable', 'stationery', 'safety', 'garden', 'other'];
export const UNITS = ['pcs', 'kg', 'g', 'l', 'ml', 'm', 'box', 'pack', 'roll', 'set', 'pair', 'can', 'bottle'];

const { ObjectId } = mongoose.Schema.Types;

// Store item. `stock` changes only through stock movements (atomic $inc), never by direct edits.
const inventoryItemSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    code: { type: String, required: true }, // ITM-0001
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: ITEM_CATEGORIES, default: 'consumable' },
    unit: { type: String, enum: UNITS, default: 'pcs' },
    description: { type: String, trim: true },
    location: { type: String, trim: true }, // store room / shelf
    reorderLevel: { type: Number, min: 0, default: 0 },
    reorderQty: { type: Number, min: 0, default: 0 },
    stock: { type: Number, default: 0 },
    avgCost: { type: Number, min: 0, default: 0 }, // paise per unit, moving weighted average
    lastPurchaseCost: { type: Number, min: 0 },
    lowStockAlertedAt: Date, // cleared when stock goes back above the reorder level
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
inventoryItemSchema.index({ society: 1, code: 1 }, { unique: true });
inventoryItemSchema.index({ society: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
inventoryItemSchema.index({ society: 1, category: 1, active: 1 });

export default mongoose.model('InventoryItem', inventoryItemSchema);
