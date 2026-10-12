import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { METHODS, PAYMENT_STATUS } from './payment.model.js';

export { idParams };

const offlineMethod = () => z.enum(['cash', 'cheque', 'upi', 'bank']);

export const recordOffline = z.object({
  bill: objectId(),
  amount: z.coerce.number().int().min(1), // paise
  method: offlineMethod(),
  reference: z.string().trim().max(60).optional(),
  paidAt: z.coerce.date().optional(),
  notes: z.string().trim().max(200).optional(),
  excessAsAdvance: z.boolean().optional(), // overpayment is held as advance credit instead of refused
});

export const recordAdvance = z.object({
  unit: objectId(),
  amount: z.coerce.number().int().min(1),
  method: offlineMethod(),
  reference: z.string().trim().max(60).optional(),
  paidAt: z.coerce.date().optional(),
  notes: z.string().trim().max(200).optional(),
});

// Pay a bill, or (residents) pay an amount in advance.
export const createOrder = z.union([z.object({ bill: objectId() }), z.object({ advance: z.coerce.number().int().min(100).max(10_000_000) })]);

export const verifyOnline = z.object({
  orderId: z.string().min(5).max(80),
  paymentId: z.string().min(5).max(80),
  signature: z.string().min(10).max(200),
});

export const mockSign = z.object({ orderId: z.string().min(5).max(80) });

export const listPayments = pageQuery.extend({
  unit: objectId().optional(),
  method: z.enum(METHODS).optional(),
  status: z.enum(PAYMENT_STATUS).optional(),
  purpose: z.enum(['bill', 'advance']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const bounce = z.object({
  reason: z.string().trim().min(3).max(200),
  charge: z.boolean().optional(), // add the society's bounce charge to the next bill (default true)
});

export const optIn = z.object({
  maxAmount: z.coerce.number().int().min(100).max(10_000_000), // paise
  method: z.enum(['upi', 'enach']).optional(),
});

export const startMandate = z.object({
  maxAmount: z.coerce.number().int().min(100).max(10_000_000), // paise
  method: z.enum(['upi', 'enach']).optional(),
});

export const confirmMandate = verifyOnline;

export const listMandates = pageQuery.extend({ status: z.enum(['pending', 'active', 'cancelled', 'failed']).optional() });
