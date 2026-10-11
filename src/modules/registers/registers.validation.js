import { z } from 'zod';
import { dateOnly, idParams, objectId, pageQuery, paise } from '../../common/utils/schemas.js';

export { idParams };

const memberFields = {
  membership: objectId().optional(),
  name: z.string().trim().min(2).max(120).optional(),
  unit: objectId().optional(),
  address: z.string().trim().max(300).optional(),
  occupation: z.string().trim().max(100).optional(),
  ageOnAdmission: z.coerce.number().int().min(18).max(120).optional(),
  admissionDate: dateOnly(),
  entranceFee: paise().optional(),
  remarks: z.string().trim().max(500).optional(),
};

export const createMember = z
  .object(memberFields)
  .refine((v) => v.name || v.membership, { message: 'Give the member\'s name or link their account', path: ['name'] });

export const updateMember = z
  .object(Object.fromEntries(Object.entries(memberFields).map(([k, v]) => [k, v.optional()])))
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const ceaseMember = z.object({ date: dateOnly(), reason: z.string().trim().min(3).max(300) });

export const listMembers = pageQuery.extend({
  status: z.enum(['active', 'ceased']).optional(),
  search: z.string().trim().max(60).optional(),
});

export const issueCertificate = z.object({
  member: objectId(),
  shareCount: z.coerce.number().int().min(1).max(100000),
  faceValue: paise().refine((v) => v > 0, 'Face value must be more than zero'),
  issueDate: dateOnly(),
  shareFrom: z.coerce.number().int().min(1).optional(), // only when back-filling an existing certificate
  unit: objectId().optional(),
});

export const cancelCertificate = z.object({ reason: z.string().trim().min(3).max(300) });

export const listCertificates = pageQuery.extend({ status: z.enum(['active', 'cancelled']).optional(), member: objectId().optional() });

export const transfer = z
  .object({
    certificate: objectId(),
    transferee: objectId().optional(), // existing register member
    newMember: z
      .object({
        membership: objectId().optional(),
        name: z.string().trim().min(2).max(120).optional(),
        address: z.string().trim().max(300).optional(),
        occupation: z.string().trim().max(100).optional(),
        entranceFee: paise().optional(),
      })
      .refine((v) => v.name || v.membership, { message: 'Give the transferee\'s name or link their account', path: ['name'] })
      .optional(),
    date: dateOnly(),
    reason: z.enum(['sale', 'gift', 'inheritance', 'other']).default('sale'),
    transferFee: paise().default(0),
    premium: paise().default(0),
    meetingRef: z.string().trim().max(120).optional(),
    remarks: z.string().trim().max(500).optional(),
  })
  .refine((v) => Boolean(v.transferee) !== Boolean(v.newMember), { message: 'Choose an existing member or enter a new member (not both)', path: ['transferee'] });

export const listTransfers = pageQuery.extend({ member: objectId().optional() });

const nominee = z.object({
  name: z.string().trim().min(2).max(120),
  relation: z.string().trim().max(60).optional(),
  address: z.string().trim().max(300).optional(),
  dateOfBirth: dateOnly().optional(),
  sharePercent: z.coerce.number().min(0.01).max(100),
  guardian: z.string().trim().max(120).optional(),
});

export const createNomination = z.object({
  member: objectId(),
  nominees: z
    .array(nominee)
    .min(1)
    .max(10)
    .refine((list) => Math.abs(list.reduce((s, n) => s + n.sharePercent, 0) - 100) < 0.001, 'Nominee shares must add up to exactly 100%'),
  witnesses: z.array(z.object({ name: z.string().trim().min(2).max(120), address: z.string().trim().max(300).optional() })).min(1).max(3),
  nominationDate: dateOnly(),
  remarks: z.string().trim().max(500).optional(),
});

export const listNominations = pageQuery.extend({ member: objectId().optional(), status: z.enum(['active', 'revoked']).optional() });
