import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { ELECTION_STATUS, ELIGIBILITY } from './election.model.js';

export { idParams };

export const nominationParams = z.object({ id: objectId(), nominationId: objectId() });
export const transitionParams = z.object({ id: objectId(), action: z.enum(['open-nominations', 'close-nominations', 'open-voting', 'close', 'cancel']) });

const position = z.object({
  title: z.string().trim().min(2).max(80),
  seats: z.coerce.number().int().min(1).max(50).default(1),
  description: z.string().trim().max(500).optional(),
});

const windows = {
  nominationStart: z.coerce.date().optional(),
  nominationEnd: z.coerce.date().optional(),
  votingStart: z.coerce.date().optional(),
  votingEnd: z.coerce.date().optional(),
};

export const createElection = z.object({
  title: z.string().trim().min(3).max(150),
  description: z.string().trim().max(3000).optional(),
  positions: z.array(position).min(1).max(30),
  eligibility: z.enum(ELIGIBILITY).default('unit_owner'),
  officer: objectId().optional(),
  ...windows,
});

export const updateElection = z
  .object({
    title: z.string().trim().min(3).max(150).optional(),
    description: z.string().trim().max(3000).optional(),
    positions: z.array(position).min(1).max(30).optional(),
    eligibility: z.enum(ELIGIBILITY).optional(),
    officer: objectId().optional(),
    ...windows,
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const listElections = pageQuery.extend({ status: z.enum(ELECTION_STATUS).optional() });

export const transitionBody = z.object({ note: z.string().trim().max(300).optional() });

export const nominate = z.object({
  position: objectId(),
  candidate: objectId().optional(), // membership id; omitted = nominate yourself
  statement: z.string().trim().max(1500).optional(),
});

export const respond = z.object({ accept: z.boolean() });

export const scrutiny = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() });

export const vote = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit confirmation code'),
  selections: z.array(z.object({ position: objectId(), nominations: z.array(objectId()).max(50) })).min(1).max(30),
});

export const resolveTie = z.object({
  position: objectId(),
  winners: z.array(objectId()).min(1).max(50),
  note: z.string().trim().min(5).max(500),
});

export const verify = z.object({ tracker: z.string().trim().min(6).max(20) });
