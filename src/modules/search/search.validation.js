import { z } from 'zod';

export const searchQuery = z.object({
  q: z.string().trim().min(2).max(60),
});
