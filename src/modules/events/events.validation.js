import { z } from 'zod';
import { idParams, objectId, pageQuery, paise } from '../../common/utils/schemas.js';
import { audienceSchema } from '../../common/utils/audienceSchema.js';

export { idParams };

const categories = ['festival', 'sports', 'meeting', 'kids', 'cultural', 'workshop', 'other'];

export const createEvent = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(5000).optional(),
  category: z.enum(categories).default('other'),
  cover: objectId().optional(), // upload id (folder "events")
  venue: z.string().trim().max(120).optional(),
  amenity: objectId().optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  audience: audienceSchema,
  capacity: z.coerce.number().int().min(1).max(100000).optional(),
  rsvpDeadline: z.coerce.date().optional(),
  maxGuests: z.coerce.number().int().min(0).max(20).default(4),
  ticketPrice: paise().max(10_000_000).default(0), // per person
  allowOnlinePayment: z.boolean().default(true),
});

export const updateEvent = z.object({
  title: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().max(5000).optional(),
  category: z.enum(categories).optional(),
  cover: objectId().optional(),
  venue: z.string().trim().max(120).optional(),
  amenity: objectId().optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  capacity: z.coerce.number().int().min(1).max(100000).nullable().optional(),
  rsvpDeadline: z.coerce.date().nullable().optional(),
  maxGuests: z.coerce.number().int().min(0).max(20).optional(),
  ticketPrice: paise().max(10_000_000).optional(),
  allowOnlinePayment: z.boolean().optional(),
});

export const cancelEvent = z.object({ reason: z.string().trim().min(3).max(300) });

export const listEvents = pageQuery.extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  when: z.enum(['upcoming', 'past']).optional(),
  status: z.enum(['scheduled', 'cancelled']).optional(),
});

export const rsvp = z.object({
  response: z.enum(['yes', 'maybe', 'no']),
  guests: z.coerce.number().int().min(0).max(20).default(0),
  paymentMode: z.enum(['venue', 'online']).optional(),
});

export const listRsvps = pageQuery.extend({
  state: z.enum(['confirmed', 'waitlisted', 'maybe', 'declined', 'cancelled']).optional(),
  search: z.string().trim().max(60).optional(),
});

export const verify = z.object({
  orderId: z.string().min(5).max(80),
  paymentId: z.string().min(5).max(80),
  signature: z.string().min(10).max(200),
});
export const mockSign = z.object({ orderId: z.string().min(5).max(80) });

export const rsvpParams = z.object({ id: objectId(), rsvpId: objectId() });
export const photoParams = z.object({ id: objectId(), photoId: objectId() });
export const collect = z.object({ method: z.enum(['cash', 'upi']) });

export const checkIn = z
  .object({
    code: z.string().trim().min(4).max(120).optional(),
    rsvpId: objectId().optional(),
    attendedCount: z.coerce.number().int().min(1).max(21).optional(),
    collect: z.enum(['cash', 'upi']).optional(), // record a pending payment as collected now
  })
  .refine((b) => b.code || b.rsvpId, { message: 'Scan a ticket or choose an attendee', path: ['code'] });

export const photos = z.object({ photos: z.array(objectId()).min(1).max(20) });
