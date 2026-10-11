import { z } from 'zod';
import { idParams, pageQuery } from '../../common/utils/schemas.js';
import { audienceSchema } from '../../common/utils/audienceSchema.js';

export { idParams };

export const createPoll = z.object({
  question: z.string().trim().min(5).max(200),
  description: z.string().trim().max(1000).optional(),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(10),
  audience: audienceSchema,
  anonymous: z.boolean().optional(),
  closesAt: z.coerce.date().refine((d) => d > new Date(), 'Closing time must be in the future').optional(),
});

export const vote = z.object({ optionIndex: z.coerce.number().int().min(0) });

export const listPolls = pageQuery.extend({ status: z.enum(['open', 'closed']).optional() });
