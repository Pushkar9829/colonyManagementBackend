import mongoose from 'mongoose';
import { PLAN_NAMES } from './subscriptions.constants.js';

// Price list edited by the super admin. One document per plan.
const planPriceSchema = new mongoose.Schema(
  {
    plan: { type: String, enum: PLAN_NAMES, required: true, unique: true },
    perUnitMonthly: { type: Number, default: 0, min: 0 }, // paise per unit per month
    flatMonthly: { type: Number, default: 0, min: 0 }, // paise per society per month
    yearlyDiscountPercent: { type: Number, default: 0, min: 0, max: 50 },
    description: { type: String, trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export default mongoose.model('PlanPrice', planPriceSchema);
