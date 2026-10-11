import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { audienceSchema } from '../../common/utils/audienceSchema.js';

export { idParams };

const categories = ['general', 'maintenance', 'event', 'meeting', 'emergency'];

export const createNotice = z.object({
  title: z.string().trim().min(3).max(150),
  body: z.string().trim().min(1).max(5000),
  category: z.enum(categories).default('general'),
  audience: audienceSchema,
  pinned: z.boolean().optional(),
  expiresAt: z.coerce.date().optional(),
  attachments: z.array(objectId()).max(5).optional(), // upload ids (folder "notices")
  sendEmail: z.boolean().optional(),
  requiresAck: z.boolean().optional(),
  publishAt: z.coerce.date().optional(),
});

export const updateNotice = z.object({
  title: z.string().trim().min(3).max(150).optional(),
  body: z.string().trim().min(1).max(5000).optional(),
  category: z.enum(categories).optional(),
  pinned: z.boolean().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  requiresAck: z.boolean().optional(),
  sendEmail: z.boolean().optional(),
  // only while the notice is still scheduled
  publishAt: z.coerce.date().nullable().optional(),
});

export const listNotices = pageQuery.extend({
  category: z.enum(categories).optional(),
  pendingAck: z.stringbool().optional(), // only notices I still have to acknowledge
  scheduled: z.stringbool().optional(), // managers: only not-yet-published notices
});
