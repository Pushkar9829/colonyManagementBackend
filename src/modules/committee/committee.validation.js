import { z } from 'zod';
import { dateOnly, idParams, objectId } from '../../common/utils/schemas.js';
import { POSITIONS } from './committeeTerm.model.js';

export { idParams };

export const positionParams = z.object({ id: objectId(), positionId: objectId() });

export const createTerm = z.object({
  name: z.string().trim().min(3).max(120),
  startDate: dateOnly(),
  endDate: dateOnly(),
  notes: z.string().trim().max(1000).optional(),
});

export const termFromElection = createTerm.extend({ election: objectId() });

export const updateTerm = z
  .object({
    name: z.string().trim().min(3).max(120).optional(),
    startDate: dateOnly().optional(),
    endDate: dateOnly().optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const addPosition = z.object({
  membership: objectId(),
  position: z.enum(POSITIONS),
  title: z.string().trim().max(80).optional(),
  isSignatory: z.boolean().optional(),
  from: dateOnly().optional(),
  notes: z.string().trim().max(300).optional(),
});

export const updatePosition = z
  .object({
    position: z.enum(POSITIONS).optional(),
    title: z.string().trim().max(80).optional(),
    isSignatory: z.boolean().optional(),
    notes: z.string().trim().max(300).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const endPosition = z.object({ to: dateOnly().optional(), notes: z.string().trim().max(300).optional() });
