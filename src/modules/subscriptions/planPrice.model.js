import mongoose from 'mongoose';
import { PLAN_NAMES } from './subscriptions.constants.js';

// Price list edited by the super admin. One document per plan.
const planPriceSchema = new mongoose.Schema(
  {
    plan: { type: String, enum: PLAN_NAMES, required: true, unique: true },
    perUnitMonthly: { type: Number, default: 0, min: 0 }, // paise per unit per month
    flatMonthly: { type: Number, default: 0, min: 0 }, // paise per society per month
    quarterlyDiscountPercent: { type: Number, default: 0, min: 0, max: 50 },
    yearlyDiscountPercent: { type: Number, default: 0, min: 0, max: 50 },
    // One-time licence: a fixed price (not per unit). 0 = not offered. No validity = lifetime.
    oneTimePrice: { type: Number, default: 0, min: 0 },
    oneTimeValidityMonths: { type: Number, min: 1, max: 120, default: null },
    description: { type: String, trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export default mongoose.model('PlanPrice', planPriceSchema);
