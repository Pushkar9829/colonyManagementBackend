import { z } from 'zod';
import { dateOnly, idParams } from '../../common/utils/schemas.js';
import { REPORT_KEYS } from './reports.definitions.js';
import { SUMMARY_SECTIONS } from './reportSchedule.model.js';

export { idParams };

export const reportParams = z.object({ key: z.enum(REPORT_KEYS) });

export const exportQuery = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'),
  from: dateOnly().optional(),
  to: dateOnly().optional(),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').optional(),
  status: z.string().trim().max(30).regex(/^[a-z_]+$/).optional(),
});

const recipients = z.array(z.email()).max(10);

export const createSchedule = z.object({
  frequency: z.enum(['weekly', 'monthly']),
  sections: z.array(z.enum(SUMMARY_SECTIONS)).min(1).optional(),
  recipients: recipients.optional(),
  enabled: z.boolean().optional(),
});

export const updateSchedule = z.object({
  sections: z.array(z.enum(SUMMARY_SECTIONS)).min(1).optional(),
  recipients: recipients.optional(),
  enabled: z.boolean().optional(),
});

export const previewQuery = z.object({ frequency: z.enum(['weekly', 'monthly']).default('monthly') });
