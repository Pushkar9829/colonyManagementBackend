import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { KYC_STATUS, KYC_TYPES } from './kycDocument.model.js';

export { idParams };

// The full number is accepted only to validate its shape; the service keeps the last 4 characters.
const AADHAAR = /^\d{12}$|^\d{4}$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$|^[A-Z0-9]{4}$/;

export const submit = z
  .object({
    type: z.enum(KYC_TYPES),
    number: z
      .string()
      .trim()
      .transform((v) => v.replace(/[\s-]/g, '').toUpperCase())
      .optional(),
    nameOnDocument: z.string().trim().max(80).optional(),
    files: z.array(objectId()).min(1).max(4), // upload ids ('documents' folder)
  })
  .superRefine((v, c) => {
    if (v.type === 'aadhaar' && (!v.number || !AADHAAR.test(v.number))) {
      c.addIssue({ code: 'custom', path: ['number'], message: 'Enter the 12-digit Aadhaar number (or its last 4 digits)' });
    }
    if (v.type === 'pan' && v.number && !PAN.test(v.number)) c.addIssue({ code: 'custom', path: ['number'], message: 'Invalid PAN' });
    if (v.number && v.number.length > 20) c.addIssue({ code: 'custom', path: ['number'], message: 'Too long' });
  });

export const reject = z.object({ reason: z.string().trim().min(3).max(300) });

export const listDocs = pageQuery.extend({
  status: z.enum(KYC_STATUS).optional(),
  type: z.enum(KYC_TYPES).optional(),
  unit: objectId().optional(),
});

export const completionQuery = pageQuery.extend({ incompleteOnly: z.stringbool().optional() });
