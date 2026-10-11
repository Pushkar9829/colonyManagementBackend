import { z } from 'zod';
import { dateOnly, hhmm, idParams, objectId, pageQuery, paise } from '../../common/utils/schemas.js';
import { POINT_KINDS } from './utilityPoint.model.js';
import { SHIFTS } from './utilityReading.model.js';

export { idParams };

const text = (max) => z.string().trim().max(max);
const num = (max = 1e9) => z.coerce.number().min(0).max(max);

const parameter = z
  .object({ key: z.string().trim().regex(/^[a-z0-9_]{1,30}$/, 'Use lowercase letters, digits or _'), label: text(40).min(1), unit: text(20).optional(), min: z.coerce.number().optional(), max: z.coerce.number().optional() })
  .refine((p) => p.min === undefined || p.max === undefined || p.max >= p.min, { message: 'max must be ≥ min', path: ['max'] });

const pointFields = {
  name: text(80).min(2),
  location: text(120).optional(),
  asset: objectId().optional(),
  capacity: num().optional(),
  parameters: z.array(parameter).max(20).optional(),
};
export const createPoint = z.object({
  kind: z.enum(POINT_KINDS),
  ...pointFields,
  openingDieselStock: num(100000).optional(),
  openingHours: num().optional(),
  openingMeterReading: num().optional(),
});
export const updatePoint = z.object({ ...pointFields, active: z.boolean() }).partial();
export const listPoints = z.object({ kind: z.enum(POINT_KINDS).optional(), active: z.stringbool().optional() });

export const createReading = z.object({
  point: objectId(),
  date: dateOnly().optional(),
  shift: z.enum(SHIFTS).optional(),
  notes: text(500).optional(),
  hoursStart: num().optional(),
  hoursEnd: num().optional(),
  runHours: num(24 * 31).optional(),
  startTime: hhmm().optional(),
  endTime: hhmm().optional(),
  runMinutes: num(24 * 60).optional(),
  dieselFilled: num(100000).optional(),
  dieselConsumed: num(100000).optional(),
  dieselCost: paise().optional(),
  levelPercent: num(100).optional(),
  levelLitres: num().optional(),
  values: z.array(z.object({ key: z.string().trim().max(30), value: z.coerce.number() })).max(20).optional(),
  meterReading: num().optional(),
  meterReset: z.boolean().optional(), // meter replaced / rolled over: start a fresh series
});

const range = { from: dateOnly().optional(), to: dateOnly().optional() };
export const listReadings = pageQuery.extend({ kind: z.enum(POINT_KINDS).optional(), point: objectId().optional(), ...range });
export const summaryQuery = z.object({ kind: z.enum(POINT_KINDS), point: objectId().optional(), groupBy: z.enum(['day', 'month']).default('day'), ...range });
export const exportQuery = summaryQuery;
