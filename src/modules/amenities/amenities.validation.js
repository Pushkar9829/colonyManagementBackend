import { z } from 'zod';
import { dateOnly, hhmm, idParams, objectId, pageQuery, paise } from '../../common/utils/schemas.js';
import { toMinutes } from '../../common/utils/dates.js';
import { BOOKING_STATUSES } from './booking.model.js';
import { PASS_STATUS } from './amenityPass.model.js';

export { idParams };

const amenityFields = {
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(500).optional(),
  rules: z.string().trim().max(1000).optional(),
  capacity: z.coerce.number().int().min(1).max(500).optional(),
  openTime: hhmm().optional(),
  closeTime: hhmm().optional(),
  slotMinutes: z.coerce.number().int().min(15).max(720).optional(),
  maxBookingsPerUnitPerDay: z.coerce.number().int().min(1).max(10).optional(),
  advanceDays: z.coerce.number().int().min(0).max(365).optional(),
  requiresApproval: z.boolean().optional(),
  fee: paise().optional(),
  deposit: paise().optional(),
  paymentMode: z.enum(['online', 'desk']).optional(),
  cancellation: z
    .object({
      fullRefundHours: z.coerce.number().min(0).max(720).optional(),
      partialRefundHours: z.coerce.number().min(0).max(720).optional(),
      partialRefundPercent: z.coerce.number().int().min(0).max(100).optional(),
    })
    .refine((c) => c.fullRefundHours === undefined || c.partialRefundHours === undefined || c.partialRefundHours <= c.fullRefundHours, {
      message: 'The partial-refund cut-off must be closer to the start than the full-refund cut-off',
      path: ['partialRefundHours'],
    })
    .optional(),
  active: z.boolean().optional(),
};

const hoursValid = (v) => !v.openTime || !v.closeTime || toMinutes(v.closeTime) > toMinutes(v.openTime);

export const createAmenity = z.object(amenityFields).refine(hoursValid, { message: 'closeTime must be after openTime', path: ['closeTime'] });
export const updateAmenity = z.object(amenityFields).partial().refine(hoursValid, { message: 'closeTime must be after openTime', path: ['closeTime'] });

export const photos = z.object({ files: z.array(objectId()).min(1).max(10) }); // upload ids ('amenities')
export const photoParams = z.object({ id: objectId(), photoId: objectId() });

export const availabilityQuery = z.object({ date: dateOnly() });

export const createBooking = z
  .object({
    amenity: objectId(),
    date: dateOnly(),
    startTime: hhmm(),
    endTime: hhmm(),
    guests: z.coerce.number().int().min(1).max(500).optional(),
    notes: z.string().trim().max(300).optional(),
  })
  .refine((v) => toMinutes(v.endTime) > toMinutes(v.startTime), { message: 'endTime must be after startTime', path: ['endTime'] });

export const decide = z.object({ approve: z.boolean(), note: z.string().trim().max(200).optional() });
export const cancel = z.object({ reason: z.string().trim().max(200).optional() });

export const listBookings = pageQuery.extend({
  amenity: objectId().optional(),
  status: z.enum(BOOKING_STATUSES).optional(),
  date: dateOnly().optional(),
  upcoming: z.stringbool().optional(),
  depositHeld: z.stringbool().optional(),
});

export const verifyPayment = z.object({
  orderId: z.string().min(4).max(100),
  paymentId: z.string().min(4).max(100),
  signature: z.string().min(8).max(200),
});

const DESK_METHODS = ['cash', 'upi', 'card', 'cheque', 'bank'];
export const markPaid = z.object({ method: z.enum(DESK_METHODS).default('cash'), reference: z.string().trim().max(60).optional() });

export const refundDeposit = z.object({
  amount: paise().optional(), // default: the full deposit
  reason: z.string().trim().max(300).optional(),
});

export const attendance = z.object({ attended: z.boolean() });

export const reportQuery = z.object({ from: dateOnly().optional(), to: dateOnly().optional(), amenity: objectId().optional() });

// ---------- passes ----------
const planFields = {
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  durationDays: z.coerce.number().int().min(1).max(366),
  price: paise(),
  active: z.boolean().optional(),
};
export const createPlan = z.object(planFields);
export const updatePlan = z.object(planFields).partial();
export const planParams = z.object({ planId: objectId() });
export const planListQuery = z.object({ amenity: objectId().optional() });

export const buyPass = z.object({ plan: objectId(), holder: objectId().optional(), validFrom: dateOnly().optional() });
export const listPasses = pageQuery.extend({ amenity: objectId().optional(), status: z.enum(PASS_STATUS).optional(), code: z.string().trim().max(12).optional() });
export const checkPass = z.object({ code: z.string().trim().min(4).max(20), amenity: objectId().optional() });
export const cancelPass = z.object({ reason: z.string().trim().max(200).optional(), refundAmount: paise().optional() });
