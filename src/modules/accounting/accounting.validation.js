import { z } from 'zod';
import { dateOnly, idParams, objectId, pageQuery, paise } from '../../common/utils/schemas.js';
import { ACCOUNT_TYPES } from './chart.js';

export { idParams };

const code = () => z.string().regex(/^\d{4}$/, 'Account codes are 4 digits');
export const codeParams = z.object({ code: code() });
export const fyParams = z.object({ fy: z.coerce.number().int().min(2000).max(2100) });

const range = { from: dateOnly().optional(), to: dateOnly().optional() };
const format = { format: z.enum(['xlsx', 'pdf']).optional() };

const bankDetails = z.object({
  bankName: z.string().trim().max(80).optional(),
  accountNumber: z.string().trim().regex(/^[0-9A-Za-z]{4,24}$/, 'Invalid account number').optional(),
  ifsc: z.string().trim().regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, 'Invalid IFSC').optional(),
  branch: z.string().trim().max(80).optional(),
});

export const listAccounts = z.object({
  type: z.enum(ACCOUNT_TYPES).optional(),
  active: z.stringbool().optional(),
  bank: z.stringbool().optional(),
  withBalances: z.stringbool().optional(),
  asOf: dateOnly().optional(),
});

export const createAccount = z.object({
  code: code(),
  name: z.string().trim().min(2).max(80),
  parent: code().optional(),
  description: z.string().trim().max(300).optional(),
  isBank: z.boolean().optional(),
  isCash: z.boolean().optional(),
  bankDetails: bankDetails.optional(),
});

export const updateAccount = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(300).optional(),
    active: z.boolean().optional(),
    bankDetails: bankDetails.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const entryLine = z
  .object({
    code: code(),
    debit: paise().default(0),
    credit: paise().default(0),
    unit: objectId().optional(),
    vendor: objectId().optional(),
    memo: z.string().trim().max(200).optional(),
  })
  .refine((l) => !(l.debit && l.credit), 'A line can have a debit or a credit, not both');

export const createJournal = z.object({
  date: dateOnly(),
  narration: z.string().trim().min(3).max(500),
  reference: z.string().trim().max(60).optional(),
  lines: z.array(entryLine).min(2).max(100),
});

export const reverseJournal = z.object({ reason: z.string().trim().min(3).max(300), date: dateOnly().optional() });

export const listJournals = pageQuery.extend({
  ...range,
  sourceType: z.string().trim().max(40).optional(),
  kind: z.enum(['manual', 'auto', 'opening', 'reversal']).optional(),
  code: code().optional(),
  search: z.string().trim().max(60).optional(),
});

export const openingBalances = z.object({
  date: dateOnly(),
  lines: z.array(z.object({ code: code(), debit: paise().default(0), credit: paise().default(0) })).min(1).max(200),
});

export const sync = z.object({ full: z.boolean().optional() });

export const rangeQuery = z.object({ ...range, ...format });
export const ledgerQuery = z.object({ code: code(), ...range, ...format });
export const asOfQuery = z.object({ asOf: dateOnly().optional(), ...format });
export const bookQuery = z.object({ code: code().optional(), ...range, ...format });
export const tallyQuery = z.object({ ...range, kind: z.enum(['vouchers', 'masters']).default('vouchers') });
export const journalExportQuery = z.object(range);
export const formatQuery = z.object(format);

export const saveBudget = z.object({
  lines: z.array(z.object({ code: code(), amount: paise(), notes: z.string().trim().max(200).optional() })).min(1).max(200),
});

// ---- bank reconciliation ----
const columnRef = z.union([z.string().trim().max(60), z.number().int().min(0).max(100), z.literal(false)]);
export const statementMapping = z
  .object({
    date: columnRef.optional(),
    description: columnRef.optional(),
    debit: columnRef.optional(),
    credit: columnRef.optional(),
    amount: columnRef.optional(),
    type: columnRef.optional(),
    reference: columnRef.optional(),
    balance: columnRef.optional(),
    headerRow: z.number().int().min(0).max(50).optional(),
    dateFormat: z.enum(['DMY', 'MDY', 'YMD']).optional(),
    amountSign: z.enum(['positive_deposit', 'positive_withdrawal']).optional(),
  })
  .default({});

export const statementLines = pageQuery.extend({ status: z.enum(['unmatched', 'matched', 'ignored']).optional(), ...range });
export const matchLine = z.object({ entryLines: z.array(objectId()).min(1).max(20) });
export const createLineEntry = z.object({
  kind: z.enum(['bank_charge', 'interest', 'other']),
  accountCode: code().optional(),
  narration: z.string().trim().min(3).max(300).optional(),
});
