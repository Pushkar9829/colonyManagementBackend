import mongoose from 'mongoose';
import { attachmentSchema } from '../assets/facility.shared.js';

export const DEPARTMENTS = ['security', 'housekeeping', 'maintenance', 'gardening', 'administration', 'accounts', 'other'];
export const EMPLOYMENT_TYPES = ['permanent', 'contract', 'probation', 'part_time'];
export const VERIFICATION_STATUS = ['not_started', 'submitted', 'verified', 'failed'];

const { ObjectId } = mongoose.Schema.Types;

// Monthly salary structure in paise. Percentages are of basic (PF) or gross (ESI).
const salarySchema = new mongoose.Schema(
  {
    basic: { type: Number, min: 0, default: 0 },
    hra: { type: Number, min: 0, default: 0 },
    allowances: { type: [new mongoose.Schema({ name: { type: String, required: true, trim: true }, amount: { type: Number, min: 0, required: true } }, { _id: false })], default: [] },
    pfPercent: { type: Number, min: 0, max: 100, default: 0 },
    esiPercent: { type: Number, min: 0, max: 100, default: 0 },
    professionalTax: { type: Number, min: 0, default: 0 }, // flat per month
  },
  { _id: false },
);

// HR profile of a society employee. Identity and role live on User / Membership; this holds the employment record.
const employeeSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    membership: { type: ObjectId, ref: 'Membership', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    employeeCode: { type: String, required: true, trim: true, uppercase: true },
    designation: { type: String, trim: true },
    department: { type: String, enum: DEPARTMENTS, default: 'other' },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: 'permanent' },
    dateOfJoining: String,
    dateOfExit: String,
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    salary: { type: salarySchema, default: () => ({}) },
    bank: {
      accountName: { type: String, trim: true },
      accountNumber: { type: String, trim: true, select: false }, // never returned; UI shows the last 4
      accountLast4: String,
      ifsc: { type: String, trim: true, uppercase: true },
      bankName: { type: String, trim: true },
    },
    pan: { type: String, trim: true, uppercase: true, select: false },
    panLast4: String,
    uan: { type: String, trim: true }, // PF universal account number
    esiNumber: { type: String, trim: true },
    emergencyContact: { name: { type: String, trim: true }, phone: { type: String, trim: true }, relation: { type: String, trim: true } },
    address: { type: String, trim: true },
    policeVerification: {
      status: { type: String, enum: VERIFICATION_STATUS, default: 'not_started' },
      date: String,
      reference: { type: String, trim: true },
      station: { type: String, trim: true },
    },
    documents: { type: [attachmentSchema], default: [] },
    defaultShift: { type: ObjectId, ref: 'StaffShift' },
    weeklyOff: { type: Number, min: 0, max: 6, default: 0 }, // used when no roster is published for the week
  },
  { timestamps: true },
);
employeeSchema.index({ society: 1, employeeCode: 1 }, { unique: true });
employeeSchema.index({ society: 1, membership: 1 }, { unique: true });
employeeSchema.index({ society: 1, user: 1 });
employeeSchema.index({ society: 1, status: 1 });

export default mongoose.model('Employee', employeeSchema);
