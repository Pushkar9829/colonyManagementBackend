import { z } from 'zod';
import { pageQuery } from '../../common/utils/schemas.js';

export const listQuery = pageQuery.extend({
  entity: z.string().optional(),
  action: z.string().optional(),
});
