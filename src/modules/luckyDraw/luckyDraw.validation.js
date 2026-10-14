import { z } from 'zod';
import { idParams, noDefaults, objectId, pageQuery } from '../../common/utils/schemas.js';
import { AUDIENCES, DRAW_STATUS } from './luckyDraw.model.js';

export { idParams };

// Entry is free, so there are no amount / fee fields here on purpose (see luckyDraw.model.js).
const prize = z.object({
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  quantity: z.coerce.number().int().min(1).max(100).default(1),
  value: z.string().trim().max(60).optional(),
});

const eligibility = z.object({
  audience: z.enum(AUDIENCES).default('all_residents'),
  perFlat: z.boolean().default(false),
  excludeCommittee: z.boolean().default(false),
});

const fields = {
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(5000).optional(),
  coverImage: objectId().nullable().optional(), // upload id (folder "luckydraw"); null removes it
  terms: z.string().trim().max(5000).optional(),
  prizes: z.array(prize).min(1).max(20),
  eligibility: eligibility.default({ audience: 'all_residents', perFlat: false, excludeCommittee: false }),
  entryOpensAt: z.coerce.date(),
  entryClosesAt: z.coerce.date(),
  drawAt: z.coerce.date(),
  reserves: z.coerce.number().int().min(0).max(10).default(0),
};

export const createDraw = z.object(fields);
export const updateDraw = z
  .object({ ...noDefaults(fields), eligibility: eligibility.partial() })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Change at least one field');

export const listDraws = pageQuery.extend({
  when: z.enum(['active', 'past']).optional(), // active = open / upcoming (and drafts for managers)
  status: z.enum(DRAW_STATUS).optional(),
});

export const listEntries = pageQuery.extend({
  status: z.enum(['entered', 'withdrawn']).optional(),
  search: z.string().trim().max(60).optional(),
});

export const reason = z.object({ reason: z.string().trim().min(3).max(500) });
export const optionalReason = z.object({ reason: z.string().trim().max(500).optional() });

export const winnerParams = z.object({ id: objectId(), winnerId: objectId() });
export const handover = z.object({
  handedOverAt: z.coerce.date().refine((d) => d <= new Date(Date.now() + 60_000), 'Handover date cannot be in the future').optional(),
  note: z.string().trim().max(300).optional(),
});

export const platformList = pageQuery.extend({
  status: z.enum(DRAW_STATUS).optional(),
  society: objectId().optional(),
});
