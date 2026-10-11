import { z } from 'zod';
import { idParams, pageQuery } from '../../common/utils/schemas.js';
import { SOS_STATUS, SOS_TYPES } from '../../common/constants/index.js';

export { idParams };

export const raise = z.object({
  type: z.enum(SOS_TYPES).default('other'),
  message: z.string().trim().max(300).optional(),
  location: z.string().trim().max(80).optional(),
});

export const resolve = z.object({ resolutionNote: z.string().trim().max(300).optional() });

export const listAlerts = pageQuery.extend({ status: z.enum(SOS_STATUS).optional() });
