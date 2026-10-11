import { z } from 'zod';
import { dateOnly, idParams, objectId, pageQuery, paise, phone } from '../../common/utils/schemas.js';
import { PR_STATUS, TDS_SECTIONS, VENDOR_BILL_STATUS, VENDOR_CATEGORIES, VENDOR_PAYMENT_METHODS } from './constants.js';

export { idParams };

const code = () => z.string().regex(/^\d{4}$/, 'Account codes are 4 digits');
const rate = () => z.coerce.number().min(0).max(30);
const optionalText = (max) => z.string().trim().max(max).optional();
const range = { from: dateOnly().optional(), to: dateOnly().optional() };

const bank = z.object({
  accountName: optionalText(80),
  accountNumber: z.string().trim().regex(/^[0-9]{6,20}$/, 'Account number should be 6-20 digits').optional(),
  ifsc: z.string().trim().regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, 'Invalid IFSC').optional(),
  bankName: optionalText(80),
  upi: z.string().trim().regex(/^[\w.-]{2,}@[a-zA-Z]{2,}$/, 'Invalid UPI id').optional(),
});

const vendorFields = {
  name: z.string().trim().min(2).max(100),
  category: z.enum(VENDOR_CATEGORIES).optional(),
  contactPerson: optionalText(80),
  phone: phone().optional(),
  email: z.email().optional(),
  gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN').optional(),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN').optional(),
  address: optionalText(300),
  bank: bank.optional(),
  defaultAccount: code().optional(),
  tdsSection: z.enum(TDS_SECTIONS).optional(),
  tdsRate: rate().optional(),
  notes: optionalText(500),
  active: z.boolean().optional(),
};
export const createVendor = z.object(vendorFields);
export const updateVendor = z.object(vendorFields).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const listVendors = pageQuery.extend({
  search: optionalText(60),
  category: z.enum(VENDOR_CATEGORIES).optional(),
  active: z.stringbool().optional(),
});
export const statementQuery = z.object(range);

export const settings = z
  .object({ autoApproveLimit: paise().optional(), defaultDueDays: z.coerce.number().int().min(0).max(180).optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// ---- purchase requests ----
const prItem = z.object({
  description: z.string().trim().min(2).max(200),
  quantity: z.coerce.number().min(0).max(100000).optional(),
  rate: paise().optional(),
  amount: paise().optional(),
}).refine((i) => i.amount !== undefined || i.rate !== undefined, 'Give a rate or an amount');

const prFields = {
  title: z.string().trim().min(3).max(150),
  vendor: objectId().optional(),
  items: z.array(prItem).max(50).optional(),
  amount: paise().optional(),
  justification: optionalText(2000),
  attachments: z.array(objectId()).max(5).optional(),
};
export const createPurchaseRequest = z.object({ ...prFields, submit: z.boolean().optional() });
export const updatePurchaseRequest = z.object(prFields).partial().extend({ vendor: objectId().nullable().optional() });
export const decision = z.object({ note: optionalText(500) });
export const rejection = z.object({ note: z.string().trim().min(3).max(500) });
export const listPurchaseRequests = pageQuery.extend({
  status: z.enum(PR_STATUS).optional(),
  vendor: objectId().optional(),
  mine: z.stringbool().optional(),
  awaitingMe: z.stringbool().optional(),
  search: optionalText(60),
});

// ---- vendor bills ----
const billLine = z.object({ description: z.string().trim().min(1).max(200), account: code(), amount: paise().refine((v) => v > 0, 'Amount must be more than zero') });
export const createBill = z.object({
  vendor: objectId(),
  billNo: z.string().trim().min(1).max(40),
  billDate: dateOnly(),
  dueDate: dateOnly().optional(),
  lines: z.array(billLine).min(1).max(50),
  gstAmount: paise().optional(),
  claimGst: z.boolean().optional(),
  tdsRate: rate().optional(),
  tdsSection: z.enum(TDS_SECTIONS).optional(),
  purchaseRequest: objectId().optional(),
  attachments: z.array(objectId()).max(5).optional(),
  notes: optionalText(500),
});
export const cancel = z.object({ reason: z.string().trim().min(3).max(300) });
export const listBills = pageQuery.extend({
  vendor: objectId().optional(),
  status: z.enum(VENDOR_BILL_STATUS).optional(),
  open: z.stringbool().optional(),
  overdue: z.stringbool().optional(),
  search: optionalText(40),
  ...range,
});

// ---- vendor payments ----
export const createPayment = z.object({
  vendor: objectId(),
  date: dateOnly(),
  amount: paise().refine((v) => v > 0, 'Amount must be more than zero'),
  method: z.enum(VENDOR_PAYMENT_METHODS),
  reference: optionalText(60),
  account: code().optional(),
  allocations: z.array(z.object({ bill: objectId(), amount: paise().refine((v) => v > 0, 'Amount must be more than zero') })).min(1).max(50),
  notes: optionalText(500),
});
export const listPayments = pageQuery.extend({
  vendor: objectId().optional(),
  method: z.enum(VENDOR_PAYMENT_METHODS).optional(),
  status: z.enum(['posted', 'cancelled']).optional(),
  search: optionalText(40),
  ...range,
});

// ---- recurring ----
const recurringFields = {
  name: z.string().trim().min(3).max(100),
  vendor: objectId(),
  lines: z.array(billLine).min(1).max(20),
  gstAmount: paise().optional(),
  claimGst: z.boolean().optional(),
  tdsRate: rate().optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(28),
  dueDays: z.coerce.number().int().min(0).max(120).optional(),
  startDate: dateOnly(),
  endDate: dateOnly().optional(),
  active: z.boolean().optional(),
};
export const createRecurring = z.object(recurringFields);
export const updateRecurring = z.object(recurringFields).partial().extend({ endDate: dateOnly().nullable().optional() }).refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const listRecurring = z.object({ active: z.stringbool().optional() });

// ---- reports ----
const format = { format: z.enum(['xlsx', 'pdf']).optional() };
export const ageingQuery = z.object({ asOf: dateOnly().optional(), ...format });
export const expenseQuery = z.object({ ...range, groupBy: z.enum(['account', 'category']).default('account'), ...format });
