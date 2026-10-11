import { z } from 'zod';
import { dateOnly, idParams, objectId, pageQuery, paise, phone } from '../../common/utils/schemas.js';
import { LEASE_STATUS, POLICE_STATUS } from './lease.model.js';

export { idParams };

const optText = (max) => z.string().trim().max(max).optional();
const contact = z.object({ name: z.string().trim().min(2).max(80), relation: optText(40), phone: phone() });
const datesValid = (v) => !v.startDate || !v.endDate || v.endDate > v.startDate;

export const createLease = z
  .object({
    unit: objectId(),
    tenantMembership: objectId(),
    ownerMembership: objectId().optional(),
    ownerName: optText(80),
    ownerPhone: phone().optional(),
    startDate: dateOnly(),
    endDate: dateOnly(),
    rent: paise().optional(),
    securityDeposit: paise().optional(),
    agreement: z.array(objectId()).max(5).optional(), // upload ids ('documents')
    emergencyContact: contact.optional(),
    notes: optText(500),
  })
  .refine(datesValid, { message: 'End date must be after the start date', path: ['endDate'] });

export const updateLease = z
  .object({
    startDate: dateOnly().optional(),
    endDate: dateOnly().optional(),
    rent: paise().optional(),
    securityDeposit: paise().optional(),
    ownerName: optText(80),
    ownerPhone: phone().optional(),
    emergencyContact: contact.optional(),
    notes: optText(500),
    policeVerification: z
      .object({ status: z.enum(POLICE_STATUS).optional(), reference: optText(60), notes: optText(300) })
      .optional(),
  })
  .refine(datesValid, { message: 'End date must be after the start date', path: ['endDate'] });

export const addDocuments = z.object({
  kind: z.enum(['agreement', 'police']),
  files: z.array(objectId()).min(1).max(5),
  reference: optText(60), // police acknowledgement number, when kind = police
});

export const endLease = z.object({
  reason: z.string().trim().min(3).max(300),
  moveOut: z.boolean().default(false), // also deactivate the tenant's membership (admin only)
});

export const listLeases = pageQuery.extend({
  status: z.enum(LEASE_STATUS).optional(),
  unit: objectId().optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(365).optional(),
  expired: z.stringbool().optional(), // end date passed but the lease is still open (move-out pending)
});

export const unitParams = z.object({ unitId: objectId() });
