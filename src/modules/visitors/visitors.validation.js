import { z } from 'zod';
import { hhmm, idParams, objectId, pageQuery, phone } from '../../common/utils/schemas.js';
import { VISITOR_PURPOSE, VISITOR_STATUS } from '../../common/constants/index.js';

export { idParams };

const clientKey = () => z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_.:-]+$/, 'Invalid key');
const vehicleNumber = () => z.string().trim().max(15).transform((v) => v.replace(/\s+/g, '').toUpperCase());

export const logEntry = z.object({
  unit: objectId(),
  name: z.string().trim().min(2).max(80),
  phone: phone().optional(),
  purpose: z.enum(VISITOR_PURPOSE).default('guest'),
  company: z.string().trim().max(60).optional(),
  vehicleNumber: vehicleNumber().optional(),
  guests: z.coerce.number().int().min(1).max(50).optional(),
  photo: objectId().optional(), // upload id of the gate photo
  // Offline mode: when the guard saw the visitor, and a device-generated key so retries don't duplicate.
  occurredAt: z.coerce.date().optional(),
  clientKey: clientKey().optional(),
  // Guard already confirmed with the household by phone (used by offline entries, and to override a
  // gate that does not take this kind of visitor).
  guardApproved: z.boolean().optional(),
  // Gate the guard is at; omitted = the guard's current gate, else the society's first gate.
  gateId: objectId().optional(),
});

export const respond = z.object({ note: z.string().trim().max(200).optional() });
export const checkOut = z.object({ occurredAt: z.coerce.date().optional(), gateId: objectId().optional() }).optional();

export const listVisitors = pageQuery.extend({
  status: z.enum(VISITOR_STATUS).optional(),
  unit: objectId().optional(),
  from: z.coerce.date().optional(), // client sends local-day bounds as ISO
  to: z.coerce.date().optional(),
  search: z.string().trim().max(60).optional(),
  flagged: z.stringbool().optional(),
  purpose: z.enum(VISITOR_PURPOSE).optional(),
  gate: objectId().optional(), // entry gate
});

const recurrence = z
  .object({
    days: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7),
    startTime: hhmm(),
    endTime: hhmm(),
  })
  .refine((r) => r.endTime > r.startTime, { message: 'End time must be after start time', path: ['endTime'] });

export const createPass = z
  .object({
    guestName: z.string().trim().min(2).max(80),
    phone: phone().optional(),
    purpose: z.enum(VISITOR_PURPOSE).default('guest'),
    validFrom: z.coerce.date(),
    validTo: z.coerce.date(),
    maxUses: z.coerce.number().int().min(1).max(100).default(1),
    recurrence: recurrence.optional(),
    gates: z.array(objectId()).max(20).default([]), // empty = any gate
  })
  .refine((v) => v.validTo > v.validFrom, { message: 'validTo must be after validFrom', path: ['validTo'] })
  .refine((v) => v.validTo - v.validFrom <= (v.recurrence ? 366 : 31) * 86400 * 1000, {
    message: 'A pass can be valid for at most 31 days (366 for recurring passes)',
    path: ['validTo'],
  });

// Guards type the 6-digit code or scan the pass QR (which carries a signed token).
export const verifyPass = z
  .object({
    code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code').optional(),
    qr: z.string().trim().min(6).max(200).optional(),
    occurredAt: z.coerce.date().optional(),
    clientKey: clientKey().optional(),
    gateId: objectId().optional(),
    // Pass is for another gate (or the gate takes no visitors) but the resident confirmed by phone.
    guardApproved: z.boolean().optional(),
  })
  .refine((v) => v.code || v.qr, { message: 'Enter the 6-digit code', path: ['code'] });

export const listPasses = pageQuery.extend({
  status: z.enum(['active', 'used', 'cancelled', 'expired']).optional(),
  kind: z.enum(['one_time', 'recurring']).optional(),
});

// ---------- watchlist ----------
const watchFields = {
  type: z.enum(['block', 'watch']),
  name: z.string().trim().min(2).max(80).optional(),
  phone: phone().optional(),
  vehicleNumber: vehicleNumber().optional(),
  photo: objectId().optional(),
  reason: z.string().trim().min(3).max(300),
  expiresAt: z.coerce.date().nullable().optional(),
};
export const createWatch = z
  .object(watchFields)
  .refine((v) => v.name || v.phone || v.vehicleNumber, { message: 'Give at least a name, phone or vehicle number', path: ['name'] });
export const updateWatch = z.object({ ...watchFields, active: z.boolean() }).partial();
export const listWatch = pageQuery.extend({
  type: z.enum(['block', 'watch']).optional(),
  active: z.stringbool().optional(),
  search: z.string().trim().max(60).optional(),
});
export const checkWatch = z
  .object({ name: z.string().trim().max(80).optional(), phone: z.string().trim().max(16).optional(), vehicleNumber: z.string().trim().max(15).optional() })
  .refine((v) => v.name || v.phone || v.vehicleNumber, { message: 'Give a name, phone or vehicle number', path: ['name'] });

// ---------- frequent visitors ----------
const frequentFields = {
  name: z.string().trim().min(2).max(80),
  phone: phone().optional(),
  purpose: z.enum(VISITOR_PURPOSE).default('guest'),
  company: z.string().trim().max(60).optional(),
  vehicleNumber: vehicleNumber().optional(),
  autoApprove: z.boolean().default(false),
};
export const createFrequent = z.union([
  z.object({ fromVisitor: objectId(), autoApprove: z.boolean().default(false) }),
  z.object(frequentFields),
]);
// No defaults here: in zod 4 they would still apply inside .partial() and overwrite stored values.
export const updateFrequent = z.object({ ...frequentFields, purpose: z.enum(VISITOR_PURPOSE), autoApprove: z.boolean() }).partial();
export const listFrequent = pageQuery.extend({ unit: objectId().optional(), search: z.string().trim().max(60).optional() });
export const frequentPass = z.object({
  validFrom: z.coerce.date().optional(),
  hours: z.coerce.number().int().min(1).max(72).default(12),
  maxUses: z.coerce.number().int().min(1).max(10).default(1),
});

// ---------- offline sync ----------
const syncOp = z.object({
  key: clientKey(),
  kind: z.enum(['entry', 'checkout', 'pass', 'help_scan']),
  occurredAt: z.coerce.date(),
  data: z.record(z.string(), z.unknown()).default({}),
  gateId: objectId().optional(), // gate the guard was at (also accepted inside data)
});
export const sync = z.object({ ops: z.array(syncOp).min(1).max(100) });

// payload schemas per op kind (validated inside the service, so one bad op doesn't reject the batch)
export const syncEntry = logEntry.omit({ occurredAt: true, clientKey: true });
export const syncCheckout = z
  .object({ visitorId: objectId().optional(), entryKey: clientKey().optional(), gateId: objectId().optional() })
  .refine((v) => v.visitorId || v.entryKey, { message: 'visitorId or entryKey is required' });
export const syncPass = z
  .object({ code: z.string().regex(/^\d{6}$/).optional(), qr: z.string().max(200).optional(), gateId: objectId().optional(), guardApproved: z.boolean().optional() })
  .refine((v) => v.code || v.qr, { message: 'code or qr is required' });
export const syncHelp = z.object({ passcode: z.string().trim().min(4).max(10), gateId: objectId().optional() });

// ---------- analytics & settings ----------
export const analytics = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), gate: objectId().optional() });

export const settings = z
  .object({
    escalationSeconds: z.coerce.number().int().min(15).max(3600),
    parcelReminderHours: z.coerce.number().int().min(1).max(240),
    patrolGraceMinutes: z.coerce.number().int().min(0).max(240),
    visitorParkingOverstayGraceMinutes: z.coerce.number().int().min(0).max(600),
    childAlertEscalationMinutes: z.coerce.number().int().min(1).max(60),
    allowUnknownExit: z.boolean(),
  })
  .partial();
