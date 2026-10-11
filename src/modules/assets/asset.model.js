import mongoose from 'mongoose';
import { attachmentSchema } from './facility.shared.js';

export const ASSET_CATEGORIES = ['lift', 'dg_set', 'pump', 'stp', 'wtp', 'transformer', 'cctv', 'fire_system', 'gym_equipment', 'other'];
export const ASSET_STATUS = ['working', 'under_repair', 'retired'];
export const AMC_COVERAGE = ['comprehensive', 'non_comprehensive', 'labour_only', 'parts_only'];

const { ObjectId } = mongoose.Schema.Types;

// Annual maintenance contract. Vendors belong to another module, so we keep the id plus a readable name.
const amcSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor' },
    vendorName: { type: String, trim: true },
    contractNumber: { type: String, trim: true },
    startDate: String, // YYYY-MM-DD
    endDate: String,
    cost: { type: Number, min: 0, default: 0 }, // paise
    coverage: { type: String, enum: AMC_COVERAGE },
    visitsPerYear: { type: Number, min: 0, default: 0 },
    contactPhone: { type: String, trim: true },
    notes: { type: String, trim: true },
    documents: { type: [attachmentSchema], default: [] },
  },
  { _id: false },
);

const assetSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    code: { type: String, required: true }, // AST-000001, encoded in the QR label
    tag: { type: String, trim: true }, // optional physical tag already painted on the equipment
    category: { type: String, enum: ASSET_CATEGORIES, required: true },
    name: { type: String, required: true, trim: true },
    location: { type: String, trim: true },
    block: { type: ObjectId, ref: 'Block' },
    make: { type: String, trim: true },
    model: { type: String, trim: true },
    serialNumber: { type: String, trim: true },
    capacity: { type: String, trim: true }, // "8 passenger", "125 kVA"
    purchaseDate: String,
    purchaseCost: { type: Number, min: 0, default: 0 },
    warrantyExpiry: String,
    amc: { type: amcSchema, default: undefined },
    amcHistory: { type: [amcSchema], default: [] },
    status: { type: String, enum: ASSET_STATUS, default: 'working' },
    photos: { type: [attachmentSchema], default: [] },
    documents: { type: [attachmentSchema], default: [] },
    notes: { type: String, trim: true },
    // keys of expiry reminders already sent, e.g. "amc:2026-12-31:7"
    alertsSent: { type: [String], default: [] },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
assetSchema.index({ society: 1, code: 1 }, { unique: true });
assetSchema.index({ society: 1, tag: 1 }, { unique: true, partialFilterExpression: { tag: { $type: 'string' } } });
assetSchema.index({ society: 1, category: 1, status: 1 });
assetSchema.index({ society: 1, 'amc.endDate': 1 });
assetSchema.index({ society: 1, warrantyExpiry: 1 });

export default mongoose.model('Asset', assetSchema);
