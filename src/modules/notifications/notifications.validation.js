import { z } from 'zod';
import { pageQuery } from '../../common/utils/schemas.js';

export const listQuery = pageQuery.extend({ unread: z.stringbool().optional() });

export const pushSubscription = z.object({
  endpoint: z.url().max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(5).max(100) }),
});

export const pushUnsubscribe = z.object({ endpoint: z.url().max(1000) });
