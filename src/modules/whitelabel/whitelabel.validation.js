import { z } from 'zod';
import { idParams, objectId, pageQuery, paise, phone } from '../../common/utils/schemas.js';
import { BILLING_CYCLES } from '../subscriptions/subscriptions.constants.js';
import { KEY_PLANS, KEY_STATUSES } from './licenceKey.model.js';
import { password } from '../users/users.validation.js';

export { idParams };

const opt = (s) => z.union([s, z.literal('')]).optional();
const brand = z.object({
  appName: opt(z.string().trim().min(2).max(40)),
  logoUrl: opt(z.url().max(500)),
  primaryColor: opt(z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #0f766e')),
  supportEmail: opt(z.email()),
  supportPhone: opt(z.string().trim().max(20)),
  customDomain: opt(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Domain only, e.g. app.partner.in')),
});
const contact = z.object({ name: opt(z.string().trim().max(80)), email: opt(z.email()), phone: opt(z.string().trim().max(20)) });

export const createReseller = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/, 'Lower-case letters, digits and dashes').optional(),
  brand: brand.optional(),
  contact: contact.optional(),
  notes: z.string().trim().max(1000).optional(),
});
export const updateReseller = createReseller.partial().extend({ status: z.enum(['active', 'suspended']).optional() });

export const listResellers = pageQuery.extend({ search: z.string().trim().max(80).optional(), status: z.enum(['active', 'suspended']).optional() });

export const addAdmin = z.object({ name: z.string().trim().min(2).max(80), email: z.email().toLowerCase(), phone: phone().optional(), password: password().optional() });
export const adminParams = z.object({ id: objectId(), userId: objectId() });

export const generateKeys = z
  .object({
    count: z.coerce.number().int().min(1).max(500),
    plan: z.enum(KEY_PLANS),
    cycle: z.enum(BILLING_CYCLES),
    validityMonths: z.coerce.number().int().min(1).max(120).nullable().optional(), // one_time: empty = lifetime
    pricePerKey: paise().max(100000000).optional(), // paise; > 0 raises a key-pack invoice
  });

export const listKeys = pageQuery.extend({ status: z.enum(KEY_STATUSES).optional(), batch: z.string().trim().max(40).optional() });
export const keyParams = z.object({ id: objectId(), keyId: objectId() });
export const ownKeyParams = z.object({ keyId: objectId() });
export const invoiceParams = z.object({ invoiceId: objectId() });
export const markPaid = z.object({ method: z.enum(['bank', 'upi', 'cheque', 'cash']), reference: z.string().trim().max(100).optional(), paidAt: z.coerce.date().optional() });

export const brandingQuery = z.object({ host: z.string().trim().max(200).optional(), slug: z.string().trim().toLowerCase().max(40).optional() });
export const applyKey = z.object({ key: z.string().trim().min(12).max(40) });
