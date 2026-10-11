import mongoose from 'mongoose';
import { COMPLAINT_PRIORITY } from '../../common/constants/index.js';

export const ESCALATION_ROLES = ['facility_manager', 'admin', 'accountant', 'staff'];

// Who hears about an overdue complaint, and when. afterHours counts from the SLA due time.
const levelSchema = new mongoose.Schema(
  {
    level: { type: Number, required: true, min: 1, max: 3 },
    afterHours: { type: Number, required: true, min: 0 },
    roles: { type: [{ type: String, enum: ESCALATION_ROLES }], default: [] },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // e.g. the secretary at level 3
    notifyAssignee: { type: Boolean, default: false },
  },
  { _id: false },
);

// One matrix per (category, priority); null means "any". The most specific active rule wins.
const escalationRuleSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    category: { type: String, default: null, lowercase: true, trim: true },
    priority: { type: String, enum: [...COMPLAINT_PRIORITY, null], default: null },
    levels: { type: [levelSchema], default: [] },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
escalationRuleSchema.index({ society: 1, category: 1, priority: 1 }, { unique: true });

export default mongoose.model('EscalationRule', escalationRuleSchema);
