import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { COMPLAINT_PRIORITY, COMPLAINT_STATUS } from '../../common/constants/index.js';
import { ESCALATION_ROLES } from './escalationRule.model.js';

export { idParams };

// Default or custom category key; the service checks it exists for the society.
const categoryKey = () => z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,30}$/, 'Invalid category');

export const createComplaint = z.object({
  category: categoryKey(),
  priority: z.enum(COMPLAINT_PRIORITY).default('medium'),
  area: z.enum(['unit', 'common']).default('unit'),
  title: z.string().trim().min(4).max(120),
  description: z.string().trim().max(2000).optional(),
  attachments: z.array(objectId()).max(5).optional(), // upload ids
});

export const assign = z.object({ assignedTo: objectId() });

// Staff-driven transitions; residents use reopen / rate.
export const changeStatus = z.object({
  status: z.enum(['in_progress', 'on_hold', 'resolved', 'closed']),
  note: z.string().trim().max(300).optional(),
  beforePhotos: z.array(objectId()).max(5).optional(), // upload ids ('complaints')
  afterPhotos: z.array(objectId()).max(5).optional(),
});

export const comment = z.object({
  text: z.string().trim().min(1).max(1000),
  internal: z.boolean().optional(),
  attachments: z.array(objectId()).max(5).optional(),
});

export const rate = z.object({ rating: z.coerce.number().int().min(1).max(5), feedback: z.string().trim().max(500).optional() });

export const reopen = z.object({ note: z.string().trim().min(3).max(300) });

export const listComplaints = pageQuery.extend({
  status: z.enum(COMPLAINT_STATUS).optional(),
  category: categoryKey().optional(),
  priority: z.enum(COMPLAINT_PRIORITY).optional(),
  assignedTo: objectId().optional(),
  mine: z.stringbool().optional(),
  overdue: z.stringbool().optional(),
});

// ---------- helpdesk settings ----------
const keywords = z.array(z.string().trim().min(2).max(40)).max(40);
export const createCategory = z.object({
  name: z.string().trim().min(2).max(40),
  keywords: keywords.optional(),
  requiresResolutionPhotos: z.boolean().optional(),
});
export const updateCategory = z.object({
  name: z.string().trim().min(2).max(40).optional(),
  keywords: keywords.optional(),
  requiresResolutionPhotos: z.boolean().optional(),
  active: z.boolean().optional(),
});
export const categoryParams = z.object({ key: categoryKey() });
export const categoryQuery = z.object({ includeInactive: z.stringbool().optional() });
export const suggestQuery = z.object({ title: z.string().trim().min(1).max(200) });

const level = z.object({
  level: z.coerce.number().int().min(1).max(3),
  afterHours: z.coerce.number().min(0).max(24 * 30),
  roles: z.array(z.enum(ESCALATION_ROLES)).max(4).default([]),
  users: z.array(objectId()).max(10).default([]),
  notifyAssignee: z.boolean().optional(),
});
export const createRule = z.object({
  category: categoryKey().nullable().optional(),
  priority: z.enum(COMPLAINT_PRIORITY).nullable().optional(),
  levels: z.array(level).min(1).max(3),
  active: z.boolean().optional(),
});
export const updateRule = z.object({ levels: z.array(level).min(1).max(3).optional(), active: z.boolean().optional() });

export const performanceQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
