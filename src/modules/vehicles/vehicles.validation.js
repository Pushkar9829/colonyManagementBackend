import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { MOVEMENT_MATCH, MOVEMENT_SOURCES } from './vehicleMovement.model.js';

export { idParams };

const plate = () => z.string().trim().min(4).max(15).transform((v) => v.replace(/[\s-]+/g, '').toUpperCase());
const rfidTag = () => z.string().trim().min(4).max(40).transform((v) => v.toUpperCase());

const fields = {
  number: plate(),
  type: z.enum(['two_wheeler', 'four_wheeler', 'other']).optional(),
  make: z.string().trim().max(40).optional(),
  color: z.string().trim().max(20).optional(),
  parkingSlot: z.string().trim().max(20).optional(),
  fuel: z.enum(['petrol', 'diesel', 'cng', 'electric', 'other']).optional(),
  rfidTag: rfidTag().optional(), // honoured for management only
};

// Residents add to their own unit; admins may pass any unit.
export const createVehicle = z.object({ ...fields, unit: objectId().optional() });
export const updateVehicle = z.object(fields).partial();
export const listVehicles = pageQuery.extend({ unit: objectId().optional(), search: z.string().trim().max(15).optional() });
export const setRfid = z.object({ rfidTag: rfidTag().nullable() });

export const logMovement = z.object({
  plate: plate(),
  direction: z.enum(['in', 'out']),
  gateId: objectId().optional(),
  gate: z.string().trim().max(40).optional(), // legacy: gate name
  note: z.string().trim().max(200).optional(),
});
export const lookup = z.object({ plate: plate(), direction: z.enum(['in', 'out']).default('in') });
export const listMovements = pageQuery.extend({
  match: z.enum(MOVEMENT_MATCH).optional(),
  direction: z.enum(['in', 'out']).optional(),
  source: z.enum(MOVEMENT_SOURCES).optional(),
  gate: z.string().trim().max(40).optional(), // gate id, or a gate name (old movements only have the name)
  plate: z.string().trim().max(15).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
