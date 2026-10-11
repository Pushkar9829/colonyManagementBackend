import { z } from 'zod';
import { hhmm, idParams, objectId, pageQuery } from '../../common/utils/schemas.js';

export { idParams };

const checkpointFields = {
  name: z.string().trim().min(2).max(60),
  location: z.string().trim().max(120).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusM: z.coerce.number().int().min(10).max(1000).optional(),
};
export const createCheckpoint = z.object(checkpointFields);
// lat/lng accept null so a wrongly placed checkpoint can drop its GPS check.
export const updateCheckpoint = z
  .object({ ...checkpointFields, lat: z.coerce.number().min(-90).max(90).nullable(), lng: z.coerce.number().min(-180).max(180).nullable(), active: z.boolean(), regenerateCode: z.boolean() })
  .partial();
export const listCheckpoints = z.object({ active: z.stringbool().optional() });

const routeFields = {
  name: z.string().trim().min(2).max(60),
  checkpoints: z.array(objectId()).min(1).max(50),
  frequencyMinutes: z.coerce.number().int().min(15).max(1440),
  startTime: hhmm(),
  endTime: hhmm(),
  days: z.array(z.coerce.number().int().min(0).max(6)).max(7).default([]),
  enforceOrder: z.boolean().default(false),
};
export const createRoute = z.object(routeFields).refine((r) => r.startTime !== r.endTime, { message: 'Start and end time must differ', path: ['endTime'] });
// No defaults here: in zod 4 they would still apply inside .partial() and overwrite stored values.
export const updateRoute = z.object({ ...routeFields, days: z.array(z.coerce.number().int().min(0).max(6)).max(7), enforceOrder: z.boolean(), active: z.boolean() })
  .partial()
  .refine((r) => !r.startTime || !r.endTime || r.startTime !== r.endTime, { message: 'Start and end time must differ', path: ['endTime'] });

export const scan = z.object({
  code: z.string().trim().min(4).max(80),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  accuracyM: z.coerce.number().min(0).max(10000).optional(),
  occurredAt: z.coerce.date().optional(),
  note: z.string().trim().max(200).optional(),
});

const period = { from: z.coerce.date().optional(), to: z.coerce.date().optional() };
export const listRounds = pageQuery.extend({ ...period, status: z.enum(['pending', 'in_progress', 'completed', 'partial', 'missed']).optional(), route: objectId().optional() });
export const listScans = pageQuery.extend({ ...period, mine: z.stringbool().optional() });
export const report = z.object(period);
