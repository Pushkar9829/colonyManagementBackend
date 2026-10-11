import { z } from 'zod';
import { idParams, objectId, pageQuery, paise } from '../../common/utils/schemas.js';
import { BILL_STATUS } from '../../common/constants/index.js';
import { ADJUSTMENT_STATUS, ADJUSTMENT_TYPES } from './adjustment.model.js';

export { idParams };

const period = () => z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const positive = () => z.coerce.number().int().min(1); // paise
const reason = () => z.string().trim().min(3).max(300);

export const generate = z.object({
  period: period(),
  dueDate: z.coerce.date().optional(), // defaults to today + society dueDays
  units: z.array(objectId()).max(5000).optional(), // default: all units
  extraLines: z.array(z.object({ head: z.string().trim().min(1).max(60), amount: paise() })).max(10).optional(),
  notes: z.string().trim().max(300).optional(),
});

export const listBills = pageQuery.extend({
  status: z.enum(BILL_STATUS).optional(),
  period: z.union([period(), z.literal('OPENING')]).optional(),
  unit: objectId().optional(),
  overdue: z.stringbool().optional(),
});

export const statementQuery = z.object({
  unit: objectId().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const listAdjustments = pageQuery.extend({
  unit: objectId().optional(),
  type: z.enum(ADJUSTMENT_TYPES).optional(),
  status: z.enum(ADJUSTMENT_STATUS).optional(),
});

export const requestWaiver = z.object({ bill: objectId(), amount: positive(), reason: reason() });
export const decideWaiver = z.object({ note: z.string().trim().max(300).optional() });
export const issueCredit = z.object({ unit: objectId(), amount: positive(), reason: reason() });
export const applyCredit = z.object({ unit: objectId() });
export const refund = z.object({
  unit: objectId(),
  amount: positive(),
  method: z.enum(['cash', 'cheque', 'upi', 'bank']),
  reference: z.string().trim().max(60).optional(),
  reason: z.string().trim().max(300).optional(),
});

export const openingBalances = z.object({
  dryRun: z.boolean().optional(),
  rows: z
    .array(
      z.object({
        unit: z.string().trim().min(1).max(30), // unit label, e.g. A-101
        amount: z.coerce.number().int().refine((v) => v !== 0, 'Amount cannot be 0'), // paise; negative = advance
        asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
      }),
    )
    .min(1)
    .max(5000),
});
