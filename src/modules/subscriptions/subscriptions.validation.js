import { z } from 'zod';
import { idParams, objectId, pageQuery, paise } from '../../common/utils/schemas.js';
import { BILLING_CYCLES, PLAN_NAMES } from './subscriptions.constants.js';

export { idParams };

export const planParams = z.object({ plan: z.enum(PLAN_NAMES) });
export const societyParams = z.object({ societyId: objectId() });
export const tokenParams = z.object({ token: z.string().min(16).max(80).regex(/^[A-Za-z0-9_-]+$/) });

export const updatePrice = z.object({
  perUnitMonthly: paise().max(10000000).optional(),
  flatMonthly: paise().max(100000000).optional(),
  yearlyDiscountPercent: z.coerce.number().min(0).max(50).optional(),
  description: z.string().trim().max(300).optional(),
});

const gstin = z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'GSTIN must be 15 characters');

export const updateMine = z.object({
  billingCycle: z.enum(BILLING_CYCLES).optional(),
  billingEmail: z.union([z.email(), z.literal('')]).optional(),
  gstin: z.union([gstin, z.literal('')]).optional(),
});

export const updateForSociety = updateMine.extend({
  graceDays: z.coerce.number().int().min(0).max(90).optional(),
  dueDays: z.coerce.number().int().min(0).max(60).optional(),
});

export const listInvoices = pageQuery.extend({
  status: z.enum(['unpaid', 'paid', 'void']).optional(),
  overdue: z.stringbool().optional(),
  society: objectId().optional(),
});

export const verify = z.object({ orderId: z.string().min(1).max(100), paymentId: z.string().min(1).max(100), signature: z.string().min(1).max(200) });
export const mockSign = z.object({ orderId: z.string().min(1).max(100) });

export const markPaid = z.object({
  method: z.enum(['bank', 'upi', 'cheque', 'cash']),
  reference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(300).optional(),
  paidAt: z.coerce.date().optional(),
});

export const voidInvoice = z.object({ reason: z.string().trim().min(3).max(300) });
