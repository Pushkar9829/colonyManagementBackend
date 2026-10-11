import { z } from 'zod';
import { idParams, pageQuery } from '../../common/utils/schemas.js';

export { idParams };

export const listSocieties = pageQuery.extend({
  search: z.string().trim().max(80).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  plan: z.enum(['trial', 'free', 'basic', 'standard', 'premium']).optional(),
});

export const updateSociety = z.object({
  active: z.boolean().optional(),
  suspendedReason: z.string().trim().max(300).optional(),
  plan: z
    .object({
      name: z.enum(['trial', 'free', 'basic', 'standard', 'premium']),
      unitLimit: z.coerce.number().int().min(1).max(100000).nullable().optional(), // default from plan
      validUntil: z.coerce.date().nullable().optional(),
    })
    .optional(),
  platformNotes: z.string().trim().max(2000).optional(),
});
