import { z } from 'zod';
import { dateOnly, hhmm, idParams, objectId, pageQuery, paise, phone } from '../../common/utils/schemas.js';
import { HANDOVER_CATEGORIES, POSSESSION_STATUS, SNAG_CATEGORIES, SNAG_STATUS } from './builder.constants.js';

export { idParams };
export const itemParams = z.object({ itemId: objectId() });

const optionalEmail = z.union([z.email(), z.literal('')]).optional().transform((v) => v || undefined);
const optionalPhone = z.union([phone(), z.literal('')]).optional().transform((v) => v || undefined);

export const schedulePossession = z.object({
  unit: objectId(),
  buyerName: z.string().trim().min(2).max(100),
  buyerPhone: optionalPhone,
  buyerEmail: optionalEmail,
  date: dateOnly(),
  startTime: hhmm(),
  endTime: hhmm(),
  notes: z.string().trim().max(1000).optional(),
  checklist: z.array(z.string().trim().min(2).max(150)).max(30).optional(),
});

export const updatePossession = z.object({
  buyerName: z.string().trim().min(2).max(100).optional(),
  buyerPhone: optionalPhone,
  buyerEmail: optionalEmail,
  date: dateOnly().optional(),
  startTime: hhmm().optional(),
  endTime: hhmm().optional(),
  notes: z.string().trim().max(1000).optional(),
  checklist: z.array(z.object({ _id: objectId(), done: z.boolean().optional(), note: z.string().trim().max(300).optional() })).max(50).optional(),
  addItems: z.array(z.string().trim().min(2).max(150)).max(10).optional(),
});

export const completePossession = z.object({ note: z.string().trim().max(500).optional() });
export const cancelPossession = z.object({ reason: z.string().trim().min(3).max(300) });

export const listPossessions = pageQuery.extend({ status: z.enum(POSSESSION_STATUS).optional(), unit: objectId().optional(), from: dateOnly().optional(), to: dateOnly().optional() });

const contractor = z.object({ name: z.string().trim().min(2).max(100), phone: optionalPhone });

export const createSnag = z.object({
  unit: objectId().optional(), // residents: always their own unit
  title: z.string().trim().min(3).max(150),
  description: z.string().trim().max(2000).optional(),
  category: z.enum(SNAG_CATEGORIES).default('other'),
  location: z.string().trim().max(80).optional(),
  photos: z.array(objectId()).max(6).optional(),
  contractor: contractor.optional(),
  targetDate: dateOnly().optional(),
});

export const updateSnag = z.object({
  status: z.enum(['in_progress', 'fixed']).optional(),
  note: z.string().trim().max(500).optional(),
  contractor: contractor.optional(),
  title: z.string().trim().min(3).max(150).optional(),
  description: z.string().trim().max(2000).optional(),
  category: z.enum(SNAG_CATEGORIES).optional(),
  location: z.string().trim().max(80).optional(),
  targetDate: dateOnly().optional(),
  fixPhotos: z.array(objectId()).max(6).optional(),
});

export const signOff = z.object({ name: z.string().trim().min(2).max(100).optional(), note: z.string().trim().max(500).optional() });
export const reopenSnag = z.object({ note: z.string().trim().min(3).max(500) });

export const listSnags = pageQuery.extend({ unit: objectId().optional(), status: z.enum(SNAG_STATUS).optional(), category: z.enum(SNAG_CATEGORIES).optional(), open: z.stringbool().optional() });

export const postProgress = z.object({
  title: z.string().trim().min(3).max(150),
  body: z.string().trim().max(4000).optional(),
  tower: z.string().trim().max(40).optional(),
  milestone: z.string().trim().max(100).optional(),
  percentComplete: z.coerce.number().int().min(0).max(100).optional(),
  photos: z.array(objectId()).max(10).optional(),
});
export const listProgress = pageQuery.extend({ tower: z.string().trim().max(40).optional() });

export const handoverItem = z.object({
  category: z.enum(HANDOVER_CATEGORIES),
  title: z.string().trim().min(2).max(150),
  details: z.string().trim().max(1000).optional(),
  amount: paise().optional(),
  quantity: z.coerce.number().int().min(0).optional(),
});

export const updateHandoverItem = z.object({
  title: z.string().trim().min(2).max(150).optional(),
  details: z.string().trim().max(1000).optional(),
  amount: paise().optional(),
  quantity: z.coerce.number().int().min(0).optional(),
  status: z.enum(['pending', 'transferred', 'not_applicable']).optional(),
  reference: z.string().trim().max(100).optional(),
});

export const signHandover = z.object({ side: z.enum(['builder', 'association']), name: z.string().trim().min(2).max(100).optional(), note: z.string().trim().max(500).optional() });
