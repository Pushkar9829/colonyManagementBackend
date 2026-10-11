import { z } from 'zod';
import { paise } from '../../common/utils/schemas.js';

const head = () => z.string().trim().min(1).max(60);
const account = () => z.string().trim().regex(/^\d{3,6}$/, 'Use a numeric account code like 4000');
const rate = () => z.coerce.number().min(0).max(28);
// GSTIN: 2-digit state code, 10-char PAN, entity number, Z, checksum.
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const uniqueHeads = (rows) => new Set(rows.map((r) => r.head.toLowerCase())).size === rows.length;

export const updateSettings = z
  .object({
    gstin: z.union([z.literal(''), z.string().trim().toUpperCase().regex(GSTIN, 'Invalid GSTIN')]),
    gstEnabled: z.boolean(),
    gstDefaultRate: rate(),
    gstExemptUpTo: paise(),
    headGst: z.array(z.object({ head: head(), rate: rate() })).max(50).refine(uniqueHeads, 'Each head can appear once'),
    headAccounts: z.array(z.object({ head: head(), account: account() })).max(50).refine(uniqueHeads, 'Each head can appear once'),
    nonOccupancy: z.object({ percent: z.coerce.number().min(0).max(100), appliesTo: z.array(z.enum(['rented', 'vacant'])).max(2) }).partial(),
    chequeBounceCharge: paise(),
    waiverApprovalRequired: z.boolean(),
    restrictAmenityForDefaulters: z.boolean(),
    autopayEnabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
