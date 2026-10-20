import { z } from 'zod';
import { hhmm } from '../../common/utils/schemas.js';
import { LANGUAGES } from './celebrations.templates.js';

const template = z.string().trim().max(600).optional();

export const updateSettings = z.object({
  enabled: z.boolean().optional(),
  sendTime: hhmm().optional(),
  channels: z.object({ whatsapp: z.boolean().optional(), inapp: z.boolean().optional(), push: z.boolean().optional() }).optional(),
  language: z.enum(LANGUAGES).optional(),
  templates: z.object({ birthday: template, anniversary: template }).optional(),
  dashboardCard: z.boolean().optional(),
});

export const preview = z.object({
  kind: z.enum(['birthday', 'anniversary']),
  template: z.string().trim().max(600).optional(),
  language: z.enum(LANGUAGES).optional(),
});

export const upcomingQuery = z.object({ days: z.coerce.number().int().min(1).max(90).optional() });
