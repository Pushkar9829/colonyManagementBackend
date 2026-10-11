import { z } from 'zod';
import { idParams, objectId, pageQuery, paise } from '../../common/utils/schemas.js';
import { METER_TYPES } from './meter.model.js';

export { idParams };

const period = () => z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const serial = () => z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9-]+$/, 'Letters, digits and dashes only');
const reading = () => z.coerce.number().min(0).max(1e10);

export const listMeters = pageQuery.extend({
  unit: objectId().optional(),
  block: objectId().optional(),
  type: z.enum(METER_TYPES).optional(),
  active: z.stringbool().optional(),
  search: z.string().trim().max(40).optional(),
});

export const createMeter = z.object({
  unit: objectId(),
  type: z.enum(METER_TYPES),
  serial: serial(),
  multiplier: z.coerce.number().min(0.0001).max(10000).optional(),
  initialReading: reading().optional(),
  installedAt: z.coerce.date().optional(),
  notes: z.string().trim().max(200).optional(),
});

export const updateMeter = z
  .object({ serial: serial(), multiplier: z.coerce.number().min(0.0001).max(10000), notes: z.string().trim().max(200), active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const replaceMeter = z.object({
  serial: serial(),
  finalReading: reading().optional(),
  initialReading: reading().optional(),
  multiplier: z.coerce.number().min(0.0001).max(10000).optional(),
  replacedAt: z.coerce.date().optional(),
});

export const addReading = z.object({ reading: reading(), readAt: z.coerce.date().optional(), note: z.string().trim().max(200).optional() });

export const bulkReadings = z.object({
  readAt: z.coerce.date().optional(),
  readings: z.array(z.object({ meter: objectId(), reading: reading(), readAt: z.coerce.date().optional() })).min(1).max(2000),
});

const deviceItem = z.object({ serial: serial(), reading: reading(), readAt: z.coerce.date().optional() });
// One reading, or a batch from a data concentrator.
export const deviceReadings = z.union([deviceItem, z.object({ readings: z.array(deviceItem).min(1).max(500) })]);

export const sheetQuery = z.object({ block: objectId().optional(), type: z.enum(METER_TYPES).optional(), period: period() });
export const consumptionQuery = z.object({ period: period(), type: z.enum(METER_TYPES).optional(), unit: objectId().optional(), block: objectId().optional() });

const slabs = z
  .array(z.object({ upTo: z.coerce.number().positive().nullable().optional(), rate: paise() }))
  .min(1)
  .max(10)
  .refine((s) => s[s.length - 1].upTo == null, 'The last slab must be open-ended (no "up to")')
  .refine((s) => s.slice(0, -1).every((x, i) => x.upTo != null && (i === 0 || x.upTo > s[i - 1].upTo)), 'Slab limits must increase')
  .transform((s) => s.map((x) => ({ upTo: x.upTo ?? null, rate: x.rate })));

export const createTariff = z.object({
  type: z.enum(METER_TYPES),
  name: z.string().trim().min(2).max(60),
  slabs,
  fixedCharge: paise().optional(),
  active: z.boolean().optional(),
});
export const updateTariff = z
  .object({ name: z.string().trim().min(2).max(60), slabs, fixedCharge: paise(), active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
