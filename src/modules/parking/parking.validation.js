import { z } from 'zod';
import { dateOnly, hhmm, idParams, objectId, pageQuery, paise } from '../../common/utils/schemas.js';
import { EV_STATUS, SLOT_TYPES, VIOLATION_TYPES } from './parking.model.js';

export { idParams };

const plate = () => z.string().trim().min(4).max(15).transform((v) => v.replace(/[\s-]+/g, '').toUpperCase());

export const area = z.object({ name: z.string().trim().min(1).max(60), level: z.string().trim().max(30).optional(), description: z.string().trim().max(200).optional() });
export const updateArea = area.partial();

const slotFields = {
  type: z.enum(SLOT_TYPES).default('four_wheeler'),
  covered: z.boolean().default(false),
  pool: z.enum(['resident', 'visitor']).default('resident'),
  notes: z.string().trim().max(200).optional(),
};
// One slot (number) or a numbered range (prefix + from..to, e.g. "B1-" 1..40).
export const createSlots = z
  .object({
    area: objectId(),
    number: z.string().trim().min(1).max(20).optional(),
    prefix: z.string().trim().max(10).optional(),
    from: z.coerce.number().int().min(0).max(9999).optional(),
    to: z.coerce.number().int().min(0).max(9999).optional(),
    ...slotFields,
  })
  .refine((v) => v.number || (v.from !== undefined && v.to !== undefined && v.to >= v.from && v.to - v.from < 500), {
    message: 'Give a slot number, or a range of at most 500 slots',
    path: ['number'],
  });
export const updateSlot = z
  .object({ area: objectId(), number: z.string().trim().min(1).max(20).transform((v) => v.toUpperCase()), type: z.enum(SLOT_TYPES), covered: z.boolean(), pool: z.enum(['resident', 'visitor']), notes: z.string().trim().max(200), active: z.boolean() })
  .partial();
export const listSlots = pageQuery.extend({
  area: objectId().optional(),
  pool: z.enum(['resident', 'visitor']).optional(),
  type: z.enum(SLOT_TYPES).optional(),
  unit: objectId().optional(),
  status: z.enum(['free', 'allotted']).optional(),
  active: z.stringbool().optional(),
  search: z.string().trim().max(20).optional(),
});
export const allot = z.object({ unit: objectId(), vehicles: z.array(objectId()).max(5).default([]) });

export const startVisitor = z
  .object({
    slot: objectId(),
    vehicleNumber: plate(),
    visitorId: objectId().optional(),
    unit: objectId().optional(),
    hours: z.coerce.number().min(0.25).max(48).optional(),
    expectedOutAt: z.coerce.date().optional(),
  })
  .refine((v) => v.hours || v.expectedOutAt, { message: 'Give hours or an expected out time', path: ['hours'] });
export const listVisitor = pageQuery.extend({ status: z.enum(['active', 'completed']).optional(), overstay: z.stringbool().optional() });

export const reportViolation = z.object({
  vehicleNumber: plate(),
  type: z.enum(VIOLATION_TYPES),
  slot: objectId().optional(),
  location: z.string().trim().max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  photos: z.array(objectId()).max(6).default([]),
  fine: z.string().trim().max(120).optional(),
});
export const listViolations = pageQuery.extend({ status: z.enum(['open', 'disputed', 'resolved', 'dismissed']).optional(), search: z.string().trim().max(15).optional() });
export const dispute = z.object({ note: z.string().trim().min(3).max(500) });
export const resolveViolation = z.object({ status: z.enum(['resolved', 'dismissed']).default('resolved'), resolution: z.string().trim().min(2).max(500) });

const chargerFields = {
  name: z.string().trim().min(2).max(60),
  location: z.string().trim().max(120).optional(),
  connector: z.string().trim().max(40).optional(),
  powerKw: z.coerce.number().min(0).max(400).optional(),
  ratePerKwh: paise().optional(),
  slotMinutes: z.coerce.number().int().min(15).max(240).optional(),
  openTime: hhmm().optional(),
  closeTime: hhmm().optional(),
  maxHoursPerBooking: z.coerce.number().int().min(1).max(24).optional(),
};
export const createCharger = z.object(chargerFields);
export const updateCharger = z.object({ ...chargerFields, active: z.boolean() }).partial();
export const listChargers = z.object({ all: z.stringbool().optional() });
export const availability = z.object({ date: dateOnly() });

export const book = z.object({
  charger: objectId(),
  date: dateOnly(),
  startTime: hhmm(),
  endTime: hhmm(),
  vehicle: objectId().optional(),
  unit: objectId().optional(), // staff booking on behalf of a unit
});
export const listBookings = pageQuery.extend({ charger: objectId().optional(), date: dateOnly().optional(), status: z.enum(EV_STATUS).optional() });
export const complete = z.object({ kwh: z.coerce.number().min(0).max(500) });
export const cancel = z.object({ noShow: z.boolean().optional() });
