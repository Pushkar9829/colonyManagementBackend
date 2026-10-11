import { z } from 'zod';
import { dateOnly, idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { ALL_ROLES } from '../../common/constants/index.js';
import { VISIBILITY } from './document.model.js';

export { idParams };

const visibility = z
  .object({ type: z.enum(VISIBILITY), roles: z.array(z.enum(ALL_ROLES)).max(10).optional() })
  .refine((v) => v.type !== 'roles' || v.roles?.length, { message: 'Select at least one role', path: ['roles'] });

const tags = z.array(z.string().trim().min(1).max(30)).max(15);

export const folder = z.object({ name: z.string().trim().min(2).max(60) });

export const createDocument = z.object({
  folder: objectId(),
  title: z.string().trim().min(2).max(150),
  description: z.string().trim().max(2000).optional(),
  tags: tags.optional(),
  visibility: visibility.optional(),
  upload: objectId(),
  note: z.string().trim().max(300).optional(),
  expiryDate: dateOnly().optional(),
  remindDaysBefore: z.coerce.number().int().min(0).max(365).optional(),
});

export const updateDocument = z
  .object({
    folder: objectId().optional(),
    title: z.string().trim().min(2).max(150).optional(),
    description: z.string().trim().max(2000).optional(),
    tags: tags.optional(),
    visibility: visibility.optional(),
    expiryDate: dateOnly().nullable().optional(),
    remindDaysBefore: z.coerce.number().int().min(0).max(365).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const addVersion = z.object({ upload: objectId(), note: z.string().trim().max(300).optional(), expiryDate: dateOnly().optional() });

export const listDocuments = pageQuery.extend({
  folder: objectId().optional(),
  q: z.string().trim().max(80).optional(),
  tag: z.string().trim().max(30).optional(),
  expiring: z.stringbool().optional(),
  archived: z.stringbool().optional(),
});

export const downloadQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
