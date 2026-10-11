import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';

export { idParams };

export const createCategory = z.object({
  name: z.string().trim().min(2).max(40),
  description: z.string().trim().max(200).optional(),
  order: z.coerce.number().int().min(0).max(1000).optional(),
});
export const updateCategory = createCategory.partial().extend({ active: z.boolean().optional() });
export const listCategories = z.object({ all: z.stringbool().optional() });

// Plain text with line breaks; links are rendered client-side from the text (no HTML accepted).
const body = z.string().trim().min(1).max(5000);
const mentions = z.array(objectId()).max(10).optional();

export const createTopic = z.object({
  category: objectId(),
  title: z.string().trim().min(5).max(150),
  body,
  attachments: z.array(objectId()).max(4).optional(), // upload ids (folder "forum")
  mentions,
});
export const updateTopic = z.object({
  title: z.string().trim().min(5).max(150).optional(),
  body: body.optional(),
  category: objectId().optional(),
});
export const listTopics = pageQuery.extend({
  category: objectId().optional(),
  search: z.string().trim().max(60).optional(),
  resolved: z.stringbool().optional(),
  mine: z.stringbool().optional(),
});
export const topicQuery = pageQuery;

export const reply = z.object({ body, mentions });
export const updateReply = z.object({ body });

export const flag = z.object({ value: z.boolean() });
export const resolved = z.object({ resolved: z.boolean() });
export const removeBody = z.object({ reason: z.string().trim().max(300).optional() });

export const report = z.object({
  targetType: z.enum(['topic', 'reply']),
  targetId: objectId(),
  reason: z.enum(['spam', 'abusive', 'harassment', 'off_topic', 'misinformation', 'other']),
  note: z.string().trim().max(500).optional(),
});
export const listReports = pageQuery.extend({ status: z.enum(['open', 'dismissed', 'actioned']).optional() });
export const resolveReports = z.object({
  targetType: z.enum(['topic', 'reply']),
  targetId: objectId(),
  action: z.enum(['dismiss', 'remove']),
  reason: z.string().trim().max(300).optional(),
});
export const mentionable = z.object({ topic: objectId().optional(), search: z.string().trim().max(60).optional() });
