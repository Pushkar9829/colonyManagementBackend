import mongoose from 'mongoose';
import { z } from 'zod';

// Reusable zod building blocks shared by module validation files.
export const isObjectId = (v) => mongoose.isValidObjectId(v);
export const objectId = () => z.string().refine(isObjectId, 'Invalid id');
export const idParams = z.object({ id: objectId() });
export const pageQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
export const hhmm = () => z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
export const dateOnly = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const phone = () => z.string().trim().regex(/^\+?[0-9]{10,13}$/, 'Invalid phone number');
export const paise = () => z.coerce.number().int().min(0);

// zod 4 still applies `.default()` inside `.partial()`, so an edit schema built from create fields would
// silently reset every defaulted field the client didn't send. Use this for update/PATCH schemas:
//   export const updateThing = z.object(noDefaults(thingFields)).partial();
export function noDefaults(shape) {
  const strip = (s) => {
    if (s instanceof z.ZodDefault) return strip(s.unwrap());
    if (s instanceof z.ZodOptional) return strip(s.unwrap()).optional();
    return s;
  };
  return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, strip(v)]));
}
