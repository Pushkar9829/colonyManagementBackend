import { z } from 'zod';
import { dateOnly, hhmm, idParams, objectId, pageQuery, paise, phone } from '../../common/utils/schemas.js';
import { DEPARTMENTS, EMPLOYMENT_TYPES, VERIFICATION_STATUS } from './employee.model.js';
import { ATTENDANCE_STATUS } from './attendance.model.js';
import { LEAVE_STATUS, LEAVE_TYPES } from './leaveRequest.model.js';
import { PAY_METHODS } from './payslip.model.js';

export { idParams };

const text = (max) => z.string().trim().max(max);
const period = () => z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const percent = () => z.coerce.number().min(0).max(100);

// ---- settings ----
export const updateSettings = z
  .object({
    geofence: z
      .object({ enabled: z.boolean(), lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), radiusM: z.coerce.number().int().min(20).max(5000).optional() })
      .refine((g) => !g.enabled || (g.lat !== undefined && g.lng !== undefined), { message: 'Set the society location to enable the geofence', path: ['lat'] }),
    requireSelfie: z.boolean(),
    lateGraceMinutes: z.coerce.number().int().min(0).max(240),
    halfDayMinutes: z.coerce.number().int().min(0).max(720),
    leaveQuota: z.object({ casual: z.coerce.number().min(0).max(60), sick: z.coerce.number().min(0).max(60), earned: z.coerce.number().min(0).max(60) }).partial(),
    pfWageCeiling: paise(),
    esiWageCeiling: paise(),
  })
  .partial();

// ---- employees ----
const salary = z.object({
  basic: paise().default(0),
  hra: paise().default(0),
  allowances: z.array(z.object({ name: text(40).min(1), amount: paise() })).max(10).default([]),
  pfPercent: percent().default(0),
  esiPercent: percent().default(0),
  professionalTax: paise().default(0),
});

const employeeFields = {
  employeeCode: z.string().trim().regex(/^[A-Za-z0-9-]{2,20}$/, 'Letters, digits and - only').optional(),
  designation: text(60).optional(),
  department: z.enum(DEPARTMENTS).default('other'),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('permanent'),
  dateOfJoining: dateOnly().optional(),
  salary: salary.optional(),
  bank: z
    .object({
      accountName: text(80).optional(),
      accountNumber: z.string().trim().regex(/^\d{6,18}$/, 'Account number must be 6–18 digits').optional(),
      ifsc: z.string().trim().regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, 'Invalid IFSC').optional(),
      bankName: text(80).optional(),
    })
    .optional(),
  pan: z.string().trim().regex(/^[A-Za-z]{5}\d{4}[A-Za-z]$/, 'Invalid PAN').optional(),
  uan: text(20).optional(),
  esiNumber: text(20).optional(),
  emergencyContact: z.object({ name: text(80).optional(), phone: phone().optional(), relation: text(30).optional() }).optional(),
  address: text(300).optional(),
  policeVerification: z.object({ status: z.enum(VERIFICATION_STATUS), date: dateOnly().optional(), reference: text(60).optional(), station: text(80).optional() }).optional(),
  documents: z.array(objectId()).max(10).optional(),
  defaultShift: objectId().optional(),
  weeklyOff: z.coerce.number().int().min(0).max(6).default(0),
};

export const createEmployee = z.object({ membership: objectId(), ...employeeFields });
export const updateEmployee = z
  .object({ ...employeeFields, department: z.enum(DEPARTMENTS), employmentType: z.enum(EMPLOYMENT_TYPES), weeklyOff: z.coerce.number().int().min(0).max(6), defaultShift: objectId().nullable(), status: z.enum(['active', 'inactive']), dateOfExit: dateOnly().nullable() })
  .partial();
export const listEmployees = pageQuery.extend({ status: z.enum(['active', 'inactive']).optional(), department: z.enum(DEPARTMENTS).optional(), search: text(60).optional() });
export const removeDocument = z.object({ url: z.string().min(1).max(500) });

// ---- shifts & roster ----
export const createShift = z.object({ name: text(40).min(1), start: hhmm(), end: hhmm(), color: text(20).optional() }).refine((s) => s.start !== s.end, { message: 'Start and end cannot be the same', path: ['end'] });
export const updateShift = z.object({ name: text(40).min(1), start: hhmm(), end: hhmm(), color: text(20), active: z.boolean() }).partial();

const monday = () => dateOnly().refine((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1, 'Week must start on a Monday');
export const rosterQuery = z.object({ weekStart: monday() });
export const saveRoster = z.object({
  weekStart: monday(),
  assignments: z.array(z.object({ employee: objectId(), shifts: z.array(objectId().nullable()).length(7) })).min(1).max(500),
});

// ---- attendance ----
const gps = { lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), accuracy: z.coerce.number().min(0).max(100000).optional() };
export const punch = z.object({ photo: objectId().optional(), ...gps }).refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'Send both latitude and longitude', path: ['lat'] });

export const markAttendance = z.object({
  employee: objectId(),
  date: dateOnly(),
  status: z.enum(['present', 'late', 'half_day', 'absent', 'week_off', 'holiday']),
  checkIn: hhmm().optional(),
  checkOut: hhmm().optional(),
  notes: text(300).optional(),
});

export const listAttendance = pageQuery.extend({
  date: dateOnly().optional(),
  from: dateOnly().optional(),
  to: dateOnly().optional(),
  employee: objectId().optional(),
  status: z.enum(ATTENDANCE_STATUS).optional(),
});
export const registerQuery = z.object({ period: period() });
export const myAttendanceQuery = z.object({ period: period().optional() });

export const devicePunches = z.object({
  punches: z
    .array(z.object({ employeeCode: z.string().trim().min(1).max(20), at: z.iso.datetime({ offset: true }), direction: z.enum(['in', 'out', 'auto']).default('auto') }))
    .min(1)
    .max(500),
});

// ---- leave ----
export const applyLeave = z
  .object({ type: z.enum(LEAVE_TYPES), from: dateOnly(), to: dateOnly(), halfDay: z.boolean().default(false), reason: text(500).optional(), employee: objectId().optional() })
  .refine((v) => v.to >= v.from, { message: 'End date must be on or after the start date', path: ['to'] })
  .refine((v) => !v.halfDay || v.from === v.to, { message: 'A half day must be a single date', path: ['halfDay'] })
  .refine((v) => v.from.slice(0, 4) === v.to.slice(0, 4), { message: 'Split leave that crosses the new year into two requests', path: ['to'] });
export const decideLeave = z.object({ approved: z.boolean(), note: text(300).optional() });
export const listLeaves = pageQuery.extend({ status: z.enum(LEAVE_STATUS).optional(), employee: objectId().optional(), year: z.coerce.number().int().min(2000).max(2100).optional(), mine: z.stringbool().optional() });
export const leaveCalendar = z.object({ period: period() });
export const balanceQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), employee: objectId().optional() });
export const setBalance = z.object({
  employee: objectId(),
  year: z.coerce.number().int().min(2000).max(2100),
  allocations: z.object({ casual: z.coerce.number().min(0).max(60), sick: z.coerce.number().min(0).max(60), earned: z.coerce.number().min(0).max(60) }).partial().optional(),
  carriedForward: z.coerce.number().min(0).max(300).optional(),
});

// ---- advances & payroll ----
export const createAdvance = z
  .object({ employee: objectId(), amount: paise().refine((v) => v > 0, 'Amount must be positive'), installment: paise().refine((v) => v > 0, 'Instalment must be positive'), date: dateOnly().optional(), reason: text(300).optional() })
  .refine((v) => v.installment <= v.amount, { message: 'Instalment cannot exceed the amount', path: ['installment'] });
export const listAdvances = z.object({ employee: objectId().optional(), status: z.enum(['active', 'closed']).optional() });

export const createRun = z.object({ period: period() });
export const listRuns = pageQuery;
export const listPayslips = pageQuery.extend({ run: objectId().optional(), period: period().optional(), status: z.enum(['draft', 'approved', 'paid']).optional(), employee: objectId().optional() });
export const adjustPayslip = z.object({
  adjustments: z.array(z.object({ head: text(40).min(1), amount: paise().refine((v) => v > 0, 'Amount must be positive'), kind: z.enum(['earning', 'deduction']) })).max(10),
});
export const payPayslip = z.object({ method: z.enum(PAY_METHODS), reference: text(80).optional(), paidAt: dateOnly().optional() });
export const payRun = payPayslip;
