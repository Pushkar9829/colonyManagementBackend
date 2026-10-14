import { z } from 'zod';
import { idParams, noDefaults, objectId } from '../../common/utils/schemas.js';

export { idParams };

const fields = {
  name: z.string().trim().min(2).max(40),
  code: z.string().trim().regex(/^[A-Za-z0-9-]{1,8}$/, 'Up to 8 letters, digits or dashes').transform((v) => v.toUpperCase()).optional(),
  allowVisitors: z.boolean().default(true),
  allowVehicles: z.boolean().default(true),
  allowStaff: z.boolean().default(true),
  allowDeliveries: z.boolean().default(true),
  isPedestrianOnly: z.boolean().default(false),
  notes: z.string().trim().max(300).optional(),
  order: z.coerce.number().int().min(0).max(999).optional(),
};

const atLeastOne = (v) => v.allowVisitors !== false || v.allowVehicles !== false || v.allowStaff !== false || v.allowDeliveries !== false;
const message = { message: 'A gate must take at least one kind of entry', path: ['allowVisitors'] };

export const createGate = z.object(fields).refine(atLeastOne, message);
// The "at least one kind" rule is checked again in the service against the stored flags.
export const updateGate = z.object({ ...noDefaults(fields), active: z.boolean() }).partial();
export const listGates = z.object({ includeInactive: z.stringbool().optional() });
export const reorder = z.object({ ids: z.array(objectId()).min(1).max(50) });
export const setPost = z.object({ gateId: objectId() });
