import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { MAX_MINUTES } from './loginAs.service.js';

export { idParams };

export const start = z
  .object({
    membershipId: objectId(),
    password: z.string().min(1, 'Enter your password').max(200),
    code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code').optional(),
    backupCode: z.string().trim().min(6).max(20).optional(),
    reason: z.string().trim().min(3, 'Say why you need to do this').max(200),
    minutes: z.coerce.number().int().min(5).max(MAX_MINUTES).optional(),
  })
  .strict();

const flag = z.boolean();
export const globalPolicy = z.object({ platform: flag.optional(), admin: flag.optional(), subadmin: flag.optional() }).strict();
// null puts a level back to the platform-wide rule.
export const societyPolicy = z.object({ platform: flag.nullable().optional(), admin: flag.nullable().optional(), subadmin: flag.nullable().optional() }).strict();

export const sessionsQuery = pageQuery.extend({ society: objectId().optional() });
export const membersQuery = pageQuery.extend({ search: z.string().trim().max(80).optional() });
