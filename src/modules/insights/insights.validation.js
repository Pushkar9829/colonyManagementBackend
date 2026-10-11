import { z } from 'zod';
import { objectId } from '../../common/utils/schemas.js';

export const suggestCategory = z.object({ title: z.string().trim().min(2).max(200), description: z.string().trim().max(2000).optional() });
export const riskQuery = z.object({ band: z.enum(['high', 'medium', 'low']).optional(), limit: z.coerce.number().int().min(1).max(500).default(50) });
export const unitParams = z.object({ unitId: objectId() });
export const templateParams = z.object({ key: z.string().regex(/^[a-z_]+$/).max(40) });
export const renderTemplate = z.object({ values: z.record(z.string(), z.string().max(2000)).default({}) });
export const healthQuery = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').optional() });
