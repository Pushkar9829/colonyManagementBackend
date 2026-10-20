import { z } from 'zod';
import { objectId } from '../../common/utils/schemas.js';
import { ROUTE_STATUSES, SELECTABLE_MODES } from './paymentSettings.model.js';

export const societyParams = z.object({ societyId: objectId() });

export const chooseMode = z.object({ mode: z.enum(SELECTABLE_MODES) });

const secret = () => z.string().trim().min(8).max(200);
export const ownKeys = z.object({
  keyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9_]{4,40}$/, 'A Razorpay key id looks like rzp_live_XXXXXXXXXXXX').optional(),
  keySecret: secret().optional(),
  webhookSecret: secret().optional(),
});

export const verifyTest = z.object({ orderId: z.string().min(5).max(80), paymentId: z.string().min(5).max(80), signature: z.string().min(10).max(200) });

export const platformUpdate = z.object({
  allowedModes: z.array(z.enum(SELECTABLE_MODES)).max(2).optional(),
  forceDisabled: z.boolean().optional(),
  forceDisabledReason: z.string().trim().max(200).optional(),
  route: z
    .object({
      linkedAccountId: z.union([z.string().trim().regex(/^acc_[A-Za-z0-9_]{4,40}$/, 'A linked account id looks like acc_XXXXXXXXXXXX'), z.literal('')]).optional(),
      status: z.enum(ROUTE_STATUSES).optional(),
      kycStatus: z.string().trim().max(40).optional(),
      commissionPercent: z.coerce.number().min(0).max(20).optional(),
      bank: z
        .object({
          accountName: z.string().trim().max(120).optional(),
          accountLast4: z.string().trim().regex(/^\d{4}$/, 'Last 4 digits only').optional(),
          ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234').optional(),
          bankName: z.string().trim().max(80).optional(),
        })
        .optional(),
    })
    .optional(),
});
