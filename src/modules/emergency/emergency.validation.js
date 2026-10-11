import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { CONTACT_CATEGORIES } from './emergency.model.js';

export { idParams };

// Emergency numbers include short codes (100, 108, 112), so this is looser than the member phone rule.
const dialable = () => z.string().trim().regex(/^\+?[0-9][0-9 -]{1,18}$/, 'Enter a phone number');

const contactFields = {
  name: z.string().trim().min(2).max(80),
  category: z.enum(CONTACT_CATEGORIES).default('other'),
  phone: dialable(),
  altPhone: dialable().optional(),
  address: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(300).optional(),
  available24x7: z.boolean().default(false),
  order: z.coerce.number().int().min(0).max(10000).optional(),
};
export const createContact = z.object(contactFields);
// Update schemas repeat the fields without defaults: in zod 4 a default inside .partial() would still fill in and overwrite stored values.
export const updateContact = z
  .object({ ...contactFields, category: z.enum(CONTACT_CATEGORIES), altPhone: dialable().or(z.literal('')), available24x7: z.boolean(), active: z.boolean() })
  .partial();
export const listContacts = z.object({ all: z.stringbool().optional() });
export const reorder = z.object({ ids: z.array(objectId()).min(1).max(200) });

const childFields = {
  name: z.string().trim().min(1).max(60),
  age: z.coerce.number().int().min(0).max(18).optional(),
  photo: objectId().optional(),
  notes: z.string().trim().max(200).optional(),
  alertOnExit: z.boolean().default(true),
};
export const createChild = z.object(childFields);
export const updateChild = z.object({ ...childFields, age: z.coerce.number().int().min(0).max(18).nullable(), alertOnExit: z.boolean(), removePhoto: z.boolean() }).partial();
export const listChildren = pageQuery.extend({ unit: objectId().optional(), search: z.string().trim().max(60).optional() });

export const exitAlert = z.object({ gate: z.string().trim().max(40).default('Main gate'), note: z.string().trim().max(200).optional() });
export const listAlerts = pageQuery.extend({ status: z.enum(['open', 'acknowledged']).optional() });
export const acknowledge = z.object({ response: z.enum(['ok', 'stop']).default('ok'), note: z.string().trim().max(200).optional() });
