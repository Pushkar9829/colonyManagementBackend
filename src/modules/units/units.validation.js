import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { OCCUPANCY, UNIT_TYPES } from '../../common/constants/index.js';

export { idParams };

export const createBlock = z.object({
  name: z.string().trim().min(1).max(40),
  floors: z.coerce.number().int().min(0).max(200).optional(),
});
export const updateBlock = createBlock.partial();

const unitFields = {
  block: objectId(),
  number: z.string().trim().min(1).max(20),
  floor: z.coerce.number().int().min(-5).max(200).optional(),
  type: z.enum(UNIT_TYPES).optional(),
  areaSqft: z.coerce.number().min(0).max(100000).optional(),
  occupancy: z.enum(OCCUPANCY).optional(),
};

export const createUnit = z.object(unitFields);
export const updateUnit = z.object(unitFields).partial();

// Generates units floor by floor: floors 1-10 x 4 per floor -> 101..104 ... 1001..1004
export const bulkCreate = z
  .object({
    block: objectId(),
    fromFloor: z.coerce.number().int().min(0).max(200),
    toFloor: z.coerce.number().int().min(0).max(200),
    unitsPerFloor: z.coerce.number().int().min(1).max(50),
    type: z.enum(UNIT_TYPES).optional(),
    areaSqft: z.coerce.number().min(0).optional(),
  })
  .refine((v) => v.toFloor >= v.fromFloor, { message: 'toFloor must be >= fromFloor', path: ['toFloor'] })
  .refine((v) => (v.toFloor - v.fromFloor + 1) * v.unitsPerFloor <= 2000, {
    message: 'At most 2000 units per request',
    path: ['unitsPerFloor'],
  });

export const listUnits = pageQuery.extend({
  block: objectId().optional(),
  occupancy: z.enum(OCCUPANCY).optional(),
  search: z.string().trim().max(40).optional(),
});
