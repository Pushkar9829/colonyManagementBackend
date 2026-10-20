import { z } from 'zod';
import { idParams, pageQuery } from '../../common/utils/schemas.js';
import { WHATSAPP_MODES } from './whatsappAccount.model.js';
import { LEDGER_ENTRIES, MESSAGE_KINDS } from './whatsappCredit.model.js';

export { idParams };

export const updateAccount = z
  .object({
    mode: z.enum(WHATSAPP_MODES).optional(),
    lowBalanceThreshold: z.coerce.number().int().min(0).max(100000).optional(),
  })
  .refine((v) => v.mode !== undefined || v.lowBalanceThreshold !== undefined, 'Nothing to change');

export const grantCredits = z.object({
  amount: z.coerce.number().int().min(1).max(1000000),
  note: z.string().trim().min(2, 'Add a note, e.g. the invoice or reason').max(300),
});

export const ledgerQuery = pageQuery.extend({
  entry: z.enum(LEDGER_ENTRIES).optional(),
  kind: z.enum(MESSAGE_KINDS).optional(),
});
