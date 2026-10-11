import { z } from 'zod';
import { dateOnly, idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { LOST_FOUND_CATEGORIES, LOST_FOUND_STATUS } from './lostFoundItem.model.js';

export { idParams };

export const createItem = z.object({
  kind: z.enum(['lost', 'found']),
  title: z.string().trim().min(3).max(100),
  description: z.string().trim().max(1000).optional(),
  category: z.enum(LOST_FOUND_CATEGORIES).default('other'),
  location: z.string().trim().max(120).optional(),
  date: dateOnly().optional(),
  photos: z.array(objectId()).max(6).optional(), // upload ids (folder "lostfound")
});

export const updateItem = z.object({
  title: z.string().trim().min(3).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  category: z.enum(LOST_FOUND_CATEGORIES).optional(),
  location: z.string().trim().max(120).optional(),
  date: dateOnly().optional(),
  photos: z.array(objectId()).max(6).optional(), // added to the existing photos
});

export const claim = z.object({ message: z.string().trim().min(5).max(500) });
export const claimParams = z.object({ id: objectId(), claimId: objectId() });
export const close = z.object({ status: z.enum(['resolved', 'closed', 'open']) });

export const listItems = pageQuery.extend({
  kind: z.enum(['lost', 'found']).optional(),
  category: z.enum(LOST_FOUND_CATEGORIES).optional(),
  status: z.enum(LOST_FOUND_STATUS).optional(),
  mine: z.stringbool().optional(),
  search: z.string().trim().max(60).optional(),
});
