import { z } from 'zod';
import { dateOnly, idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { COLLECTOR_TYPES, PARCEL_STATUS } from './parcel.model.js';

export { idParams };

export const createParcel = z.object({
  unit: objectId(),
  courier: z.string().trim().min(2).max(60),
  trackingNo: z.string().trim().max(60).optional(),
  recipientName: z.string().trim().max(80).optional(),
  packages: z.coerce.number().int().min(1).max(50).optional(),
  photo: objectId().optional(),
  storageLocation: z.string().trim().max(40).optional(),
  note: z.string().trim().max(200).optional(),
  visitorId: objectId().optional(), // the delivery visitor entry, when logged together
});

export const listParcels = pageQuery.extend({
  status: z.enum(PARCEL_STATUS).optional(),
  open: z.stringbool().optional(),
  unit: objectId().optional(),
  search: z.string().trim().max(60).optional(),
  olderThanHours: z.coerce.number().int().min(1).max(24 * 60).optional(),
});

export const collect = z
  .object({
    otp: z.string().trim().regex(/^\d{4}$/, 'Enter the 4-digit OTP'),
    collectedByType: z.enum(COLLECTOR_TYPES).default('resident'),
    collectedByName: z.string().trim().max(80).optional(),
  })
  .refine((v) => v.collectedByType === 'resident' || v.collectedByName, { message: 'Name of the person collecting', path: ['collectedByName'] });

export const markReturned = z.object({ reason: z.string().trim().min(3).max(200) });

export const createPreference = z.object({
  company: z.string().trim().min(2).max(60).optional(), // omitted = any delivery company
  oneOff: z.boolean().default(false),
  date: dateOnly().optional(),
  note: z.string().trim().max(120).optional(),
});

export const checkPreference = z.object({ unit: objectId(), company: z.string().trim().max(60).optional() });
