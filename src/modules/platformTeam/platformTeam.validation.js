import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { ALL_PERMISSIONS } from './permissions.js';

export { idParams };

const permissions = z.array(z.enum(ALL_PERMISSIONS)).min(1, 'Pick at least one permission').max(ALL_PERMISSIONS.length);

export const createRole = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  permissions,
});

export const updateRole = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(300).optional(),
    permissions: permissions.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const invite = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().trim().toLowerCase(),
  roleId: objectId(),
});

export const changeRole = z.object({ roleId: objectId() });

export const listMembers = pageQuery.extend({
  status: z.enum(['active', 'inactive']).optional(),
  search: z.string().trim().max(80).optional(),
});

export const activity = pageQuery.extend({
  actor: objectId().optional(),
  // Exact action ('invoice.voided') or a whole area ('invoice').
  action: z.string().trim().max(60).regex(/^[a-z_.]+$/, 'Invalid action').optional(),
  society: objectId().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
