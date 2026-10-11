import { z } from 'zod';
import { idParams, objectId, pageQuery, phone } from '../../common/utils/schemas.js';
import { RESIDENT_TYPES, ROLES, USER_STATUS } from '../../common/constants/index.js';

export { idParams };

const assignableRoles = [ROLES.ADMIN, ROLES.ACCOUNTANT, ROLES.FACILITY_MANAGER, ROLES.GUARD, ROLES.RESIDENT, ROLES.STAFF];
export const password = () => z.string().min(8, 'Password must be at least 8 characters').max(72);

const residentRules = (v, ctx) => {
  if (v.role === ROLES.RESIDENT) {
    if (!v.unit) ctx.addIssue({ code: 'custom', path: ['unit'], message: 'Unit is required for residents' });
    if (!v.residentType) ctx.addIssue({ code: 'custom', path: ['residentType'], message: 'Resident type is required' });
  }
  if (!v.email && !v.phone) ctx.addIssue({ code: 'custom', path: ['email'], message: 'Email or phone is required' });
};

export const createUser = z
  .object({
    name: z.string().trim().min(2).max(80),
    email: z.email().toLowerCase().optional(),
    phone: phone().optional(),
    password: password().optional(), // only needed when the person has no account yet
    role: z.enum(assignableRoles),
    residentType: z.enum(RESIDENT_TYPES).optional(),
    unit: objectId().optional(),
    designation: z.string().trim().max(60).optional(),
  })
  .superRefine(residentRules);

export const updateUser = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  email: z.email().toLowerCase().optional(),
  phone: phone().optional(),
  role: z.enum(assignableRoles).optional(),
  residentType: z.enum(RESIDENT_TYPES).optional(),
  unit: objectId().nullable().optional(),
  designation: z.string().trim().max(60).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const resetPassword = z.object({ password: password() });

export const listUsers = pageQuery.extend({
  role: z.enum(Object.values(ROLES)).optional(),
  status: z.enum(USER_STATUS).optional(),
  unit: objectId().optional(),
  search: z.string().trim().max(60).optional(),
});
