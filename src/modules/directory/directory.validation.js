import { z } from 'zod';
import { objectId, pageQuery } from '../../common/utils/schemas.js';
import { OCCUPATION_TYPES, WORK_CATEGORY_KEYS } from '../people/occupation.js';

export const updateMine = z.object({
  listed: z.boolean().optional(),
  showPhone: z.boolean().optional(),
  showEmail: z.boolean().optional(),
  showProfession: z.boolean().optional(),
  showBirthday: z.boolean().optional(),
  showOccupation: z.boolean().optional(),
  profession: z.string().trim().max(80).optional(),
  skills: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  about: z.string().trim().max(300).optional(),
});

export const listDirectory = pageQuery.extend({
  search: z.string().trim().max(60).optional(),
  block: objectId().optional(),
  // Occupation filters match only people who chose to show their occupation.
  occupationType: z.enum(OCCUPATION_TYPES).optional(),
  occupationCategory: z.enum(WORK_CATEGORY_KEYS).optional(),
  institution: z.string().trim().min(2).max(80).optional(),
});
