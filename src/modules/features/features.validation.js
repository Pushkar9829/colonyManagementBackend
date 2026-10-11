import { z } from 'zod';
import { idParams } from '../../common/utils/schemas.js';
import { FEATURE_KEYS } from './features.catalogue.js';

export { idParams };

export const setOverrides = z.object({
  overrides: z.partialRecord(z.enum(FEATURE_KEYS), z.boolean().nullable()).refine((o) => Object.keys(o).length > 0, 'Change at least one feature'),
  note: z.string().trim().max(200).optional(),
});
