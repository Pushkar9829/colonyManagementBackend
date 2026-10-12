import { z } from 'zod';
import { paise } from '../../common/utils/schemas.js';

export const updateProfile = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  pincode: z.string().trim().max(10).optional(),
  contactEmail: z.email().optional().or(z.literal('')),
  contactPhone: z.string().trim().max(15).optional(),
});

export const updateSettings = z.object({
  billing: z
    .object({
      perSqftRate: paise().optional(),
      fixedAmount: paise().optional(),
      chargeHeads: z.array(z.object({ name: z.string().trim().min(1).max(60), amount: paise() })).max(20).optional(),
      dueDays: z.coerce.number().int().min(0).max(90).optional(),
      autoGenerate: z.boolean().optional(),
      generateDay: z.coerce.number().int().min(1).max(28).optional(),
      lateFeeType: z.enum(['none', 'flat', 'percent']).optional(),
      lateFeeValue: z.coerce.number().min(0).optional(),
    })
    .optional(),
  complaintSlaHours: z
    .object({
      low: z.coerce.number().int().positive().optional(),
      medium: z.coerce.number().int().positive().optional(),
      high: z.coerce.number().int().positive().optional(),
      urgent: z.coerce.number().int().positive().optional(),
    })
    .optional(),
  visitorApprovalRequired: z.boolean().optional(),
  security: z.object({ requireMfa: z.boolean().optional() }).optional(),
});
