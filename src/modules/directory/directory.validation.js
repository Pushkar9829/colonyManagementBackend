import { z } from 'zod';
import { objectId, pageQuery } from '../../common/utils/schemas.js';

export const updateMine = z.object({
  listed: z.boolean().optional(),
  showPhone: z.boolean().optional(),
  showEmail: z.boolean().optional(),
  showProfession: z.boolean().optional(),
  profession: z.string().trim().max(80).optional(),
  skills: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  about: z.string().trim().max(300).optional(),
});

export const listDirectory = pageQuery.extend({
  search: z.string().trim().max(60).optional(),
  block: objectId().optional(),
});
