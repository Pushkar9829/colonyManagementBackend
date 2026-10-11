import { z } from 'zod';
import { objectId } from './schemas.js';
import { ALL_ROLES } from '../constants/index.js';

export const audienceSchema = z
  .object({
    type: z.enum(['all', 'blocks', 'roles']).default('all'),
    blocks: z.array(objectId()).max(100).optional(),
    roles: z.array(z.enum(ALL_ROLES)).max(10).optional(),
  })
  .default({ type: 'all' })
  .refine((a) => a.type !== 'blocks' || a.blocks?.length, { message: 'Select at least one block', path: ['blocks'] })
  .refine((a) => a.type !== 'roles' || a.roles?.length, { message: 'Select at least one role', path: ['roles'] });
