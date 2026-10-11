import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';

export { idParams };

export const openDirect = z.object({ userId: objectId() });
export const openDesk = z.object({ desk: z.enum(['security', 'management']), member: objectId().optional() });

export const sendMessage = z
  .object({
    text: z.string().max(2000).optional().default(''),
    attachments: z.array(objectId()).max(4).optional(), // upload ids (folder "chat", images only)
  })
  .refine((m) => m.text.trim() || m.attachments?.length, { message: 'Type a message or attach a photo', path: ['text'] });

export const listMessages = z.object({
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const listConversations = pageQuery;
export const contacts = z.object({ search: z.string().trim().max(60).optional() });
export const blockBody = z.object({ userId: objectId() });
export const userParams = z.object({ userId: objectId() });
