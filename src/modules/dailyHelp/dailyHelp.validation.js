import { z } from 'zod';
import { dateOnly, idParams, objectId, pageQuery, paise, phone } from '../../common/utils/schemas.js';
import { HELP_DOC_KINDS, HELP_VERIFICATION } from './dailyHelp.model.js';
import { HELP_TYPES } from '../../common/constants/index.js';

export { idParams };

export const createHelp = z.object({
  name: z.string().trim().min(2).max(80),
  phone: phone().optional(),
  type: z.enum(HELP_TYPES).default('maid'),
  units: z.array(objectId()).max(30).optional(), // admins only; residents use their own unit
  allowedGates: z.array(objectId()).max(20).optional(), // management only; empty = any gate
});

export const updateHelp = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  phone: phone().optional(),
  type: z.enum(HELP_TYPES).optional(),
  units: z.array(objectId()).max(30).optional(),
  allowedGates: z.array(objectId()).max(20).optional(),
  active: z.boolean().optional(),
});

export const listHelp = pageQuery.extend({
  type: z.enum(HELP_TYPES).optional(),
  inside: z.stringbool().optional(),
  search: z.string().trim().max(60).optional(),
  gate: objectId().optional(), // gate of the last scan (with inside=true: inside, came in by this gate)
});

export const gateScan = z.object({ passcode: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit passcode'), gateId: objectId().optional() });

export const reviewBody = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  text: z.string().trim().max(500).optional(),
});

export const employment = z.object({
  salary: paise().max(10000000).optional(),
  dueDay: z.coerce.number().int().min(1).max(28).optional(),
  remindersOn: z.boolean().optional(),
});

export const salaryPaid = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').optional() });

export const leaveBody = z.object({
  date: dateOnly(),
  kind: z.enum(['leave', 'absent']).default('leave'),
  reason: z.string().trim().max(200).optional(),
});

export const leaveQuery = pageQuery.extend({ from: dateOnly().optional(), to: dateOnly().optional() });
export const leaveParams = z.object({ id: objectId(), leaveId: objectId() });

export const documentsBody = z.object({
  kind: z.enum(HELP_DOC_KINDS),
  files: z.array(objectId()).min(1).max(4), // upload ids ('documents')
});

export const verificationBody = z.object({
  status: z.enum(HELP_VERIFICATION),
  notes: z.string().trim().max(300).optional(),
});
