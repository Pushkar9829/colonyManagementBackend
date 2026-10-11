import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { SUPPORT_CATEGORIES, SUPPORT_PRIORITY, SUPPORT_STATUS } from './supportTicket.model.js';

export { idParams };

export const createTicket = z.object({
  category: z.enum(SUPPORT_CATEGORIES),
  priority: z.enum(SUPPORT_PRIORITY).default('medium'),
  subject: z.string().trim().min(4).max(150),
  description: z.string().trim().max(4000).optional(),
  attachments: z.array(objectId()).max(5).optional(),
});

export const reply = z.object({ text: z.string().trim().min(1).max(4000), attachments: z.array(objectId()).max(5).optional() });
export const close = z.object({ rating: z.coerce.number().int().min(1).max(5).optional() });
export const reopen = z.object({ note: z.string().trim().min(3).max(1000) });

export const listMine = pageQuery.extend({ status: z.enum(SUPPORT_STATUS).optional(), active: z.stringbool().optional() });

export const listAll = listMine.extend({
  priority: z.enum(SUPPORT_PRIORITY).optional(),
  category: z.enum(SUPPORT_CATEGORIES).optional(),
  society: objectId().optional(),
  awaiting: z.enum(['platform', 'society', 'none']).optional(),
  breached: z.stringbool().optional(),
  mine: z.stringbool().optional(),
  search: z.string().trim().max(80).optional(),
});

export const platformReply = z.object({ text: z.string().trim().min(1).max(4000), status: z.enum(['in_progress', 'waiting_on_customer', 'resolved']).optional() });
export const setStatus = z.object({ status: z.enum(SUPPORT_STATUS), note: z.string().trim().max(500).optional() });
export const assign = z.object({ assignedTo: objectId().optional() });
