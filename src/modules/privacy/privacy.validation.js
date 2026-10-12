import { z } from 'zod';
import { DELETION_STATUS } from './deletionRequest.model.js';

export { idParams } from '../../common/utils/schemas.js';

export const deletionRequest = z.object({ reason: z.string().trim().max(500).optional() });

export const listRequests = z.object({
  status: z.enum(DELETION_STATUS).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const approve = z.object({ note: z.string().trim().max(500).optional() });
// The person is told why, so a rejection needs a reason.
export const reject = z.object({ note: z.string().trim().min(3, 'Tell the member why').max(500) });
