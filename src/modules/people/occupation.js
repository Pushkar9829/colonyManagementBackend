import mongoose from 'mongoose';
import { z } from 'zod';
import { dateOnly } from '../../common/utils/schemas.js';
import { localDateString } from '../../common/utils/dates.js';

// Personal details shared by app residents (PersonalDetails) and family members without a login (Household).
export const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];
export const OCCUPATION_TYPES = ['student', 'working', 'homemaker', 'retired', 'other'];
export const INSTITUTION_TYPES = ['school', 'college', 'university', 'coaching', 'other'];
export const WORK_MODES = ['job', 'business', 'self_employed'];
export const WORK_CATEGORIES = [
  { value: 'it_software', label: 'IT / Software' },
  { value: 'healthcare', label: 'Healthcare / Medical' },
  { value: 'education', label: 'Education' },
  { value: 'government', label: 'Government' },
  { value: 'banking_finance', label: 'Banking / Finance' },
  { value: 'retail_trade', label: 'Retail / Trade' },
  { value: 'manufacturing', label: 'Manufacturing' },
  { value: 'real_estate', label: 'Real estate / Construction' },
  { value: 'legal', label: 'Legal' },
  { value: 'hospitality_food', label: 'Hospitality / Food' },
  { value: 'transport_logistics', label: 'Transport / Logistics' },
  { value: 'media_creative', label: 'Media / Creative' },
  { value: 'agriculture', label: 'Agriculture' },
  { value: 'armed_forces_police', label: 'Armed forces / Police' },
  { value: 'other', label: 'Other' },
];
export const WORK_CATEGORY_KEYS = WORK_CATEGORIES.map((c) => c.value);

// ---------- mongoose ----------
const trimmed = (max) => ({ type: String, trim: true, maxlength: max });
export const occupationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: OCCUPATION_TYPES, required: true },
    student: {
      type: new mongoose.Schema(
        { institutionName: trimmed(120), institutionType: { type: String, enum: INSTITUTION_TYPES }, course: trimmed(80), address: trimmed(200) },
        { _id: false },
      ),
      default: undefined,
    },
    working: {
      type: new mongoose.Schema(
        { mode: { type: String, enum: WORK_MODES }, organisation: trimmed(120), designation: trimmed(80), category: { type: String, enum: WORK_CATEGORY_KEYS }, details: trimmed(300), workAddress: trimmed(200) },
        { _id: false },
      ),
      default: undefined,
    },
    notes: trimmed(200), // homemaker / retired / other
  },
  { _id: false },
);

// Calendar dates as YYYY-MM-DD (IST). "MM-DD" is what the daily wishes job matches on.
export const monthDay = (ymd) => (typeof ymd === 'string' && ymd.length === 10 ? ymd.slice(5) : undefined);

// ---------- zod ----------
const text = (max) => z.string().trim().max(max);
const clearable = (max) => text(max).optional().or(z.literal('').transform(() => undefined));
const isRealDate = (v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
export const pastDateSchema = () =>
  dateOnly()
    .refine(isRealDate, 'Not a real date')
    .refine((v) => v >= '1900-01-01', 'Date is too far in the past')
    .refine((v) => v <= localDateString(), 'Date cannot be in the future');

export const occupationBody = z
  .object({
    type: z.enum(OCCUPATION_TYPES),
    student: z
      .object({
        institutionName: text(120).min(2, 'Enter the school / college name'),
        institutionType: z.enum(INSTITUTION_TYPES).default('school'),
        course: clearable(80),
        address: clearable(200),
      })
      .optional(),
    working: z
      .object({
        mode: z.enum(WORK_MODES),
        organisation: clearable(120),
        designation: clearable(80),
        category: z.enum(WORK_CATEGORY_KEYS),
        details: clearable(300),
        workAddress: clearable(200),
      })
      .optional(),
    notes: clearable(200),
  })
  .superRefine((v, c) => {
    if (v.type === 'student' && !v.student) c.addIssue({ code: 'custom', path: ['student'], message: 'Add the school / college details' });
    if (v.type === 'working' && !v.working) c.addIssue({ code: 'custom', path: ['working'], message: 'Add the work details' });
  })
  // Only the branch that matches the type is kept, so switching type never leaves stale data behind.
  .transform((v) => ({
    type: v.type,
    ...(v.type === 'student' ? { student: v.student } : {}),
    ...(v.type === 'working' ? { working: v.working } : {}),
    ...(v.notes && !['student', 'working'].includes(v.type) ? { notes: v.notes } : {}),
  }));

// The fields every "personal details" form sends (null clears a field).
export const personalFields = {
  dateOfBirth: pastDateSchema().nullable().optional(),
  anniversaryDate: pastDateSchema().nullable().optional(),
  gender: z.enum(GENDERS).nullable().optional(),
  occupation: occupationBody.nullable().optional(),
};
export const anniversaryAfterBirth = (v) => !v.dateOfBirth || !v.anniversaryDate || v.anniversaryDate > v.dateOfBirth;

// ---------- privacy ----------
// What a neighbour may see of someone's occupation when they chose to show it: no addresses, no notes.
export function publicOccupation(o) {
  if (!o?.type) return undefined;
  const out = { type: o.type };
  if (o.type === 'student' && o.student) out.student = { institutionName: o.student.institutionName, institutionType: o.student.institutionType, course: o.student.course };
  if (o.type === 'working' && o.working) out.working = { mode: o.working.mode, organisation: o.working.organisation, designation: o.working.designation, category: o.working.category };
  return out;
}

export const categoryLabel = (key) => WORK_CATEGORIES.find((c) => c.value === key)?.label || key;

// Plain words for searching the directory (only for people who show their occupation).
export function occupationText(o) {
  const p = publicOccupation(o);
  if (!p) return [];
  return [p.type, p.student?.institutionName, p.student?.course, p.working?.organisation, p.working?.designation, p.working?.category && categoryLabel(p.working.category)].filter(Boolean);
}
