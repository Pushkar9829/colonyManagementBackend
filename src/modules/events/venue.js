import Amenity from '../amenities/amenity.model.js';
import Booking from '../amenities/booking.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { localDateString, toMinutes } from '../../common/utils/dates.js';
import { holding } from '../amenities/amenities.service.js';

// An event held at a bookable amenity reserves it: one booking per local (IST) day the event spans,
// clipped to the amenity's opening hours. Re-run on every change; the old reservation is replaced.

const istTime = (d) => new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const fromMinutes = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// [{ date, startTime, endTime }] for each day of the event within opening hours.
export function venueSlots(event, amenity) {
  const open = toMinutes(amenity.openTime || '00:00');
  const close = toMinutes(amenity.closeTime || '23:59');
  const firstDay = localDateString(event.startAt);
  const lastDay = localDateString(new Date(new Date(event.endAt).getTime() - 1));
  const slots = [];
  for (let d = new Date(`${firstDay}T00:00:00+05:30`); localDateString(d) <= lastDay; d = new Date(d.getTime() + 86400000)) {
    const day = localDateString(d);
    const start = Math.max(open, day === firstDay ? toMinutes(istTime(event.startAt)) : open);
    const end = Math.min(close, day === lastDay ? toMinutes(istTime(event.endAt)) || 24 * 60 : close);
    if (end > start) slots.push({ date: day, startTime: fromMinutes(start), endTime: fromMinutes(end) });
  }
  return slots;
}

export async function releaseVenue(ctx, eventId) {
  await Booking.updateMany(
    { society: ctx.societyId, event: eventId, status: { $in: ['pending', 'confirmed', 'payment_pending'] } },
    { status: 'cancelled', cancelledAt: new Date(), cancelledBy: ctx.userId, cancelReason: 'Event changed or cancelled' },
  );
}

// Throws 409 when the amenity is already taken for any part of the event.
// The event's own current bookings are ignored in the clash check and only released once the new slots are free,
// so a failed reschedule leaves the existing reservation in place.
export async function reserveVenue(ctx, event) {
  if (!event.amenity || event.status === 'cancelled') {
    await releaseVenue(ctx, event._id);
    return [];
  }
  const amenity = await Amenity.findOne({ _id: event.amenity, society: ctx.societyId }).lean();
  if (!amenity) throw ApiError.badRequest('Amenity not found');
  const slots = venueSlots(event, amenity);
  if (!slots.length) throw ApiError.badRequest(`${amenity.name} is closed at the event time (${amenity.openTime}–${amenity.closeTime})`);

  for (const slot of slots) {
    // eslint-disable-next-line no-await-in-loop
    const taken = await Booking.find({ society: ctx.societyId, amenity: amenity._id, date: slot.date, event: { $ne: event._id }, ...holding() })
      .select('startTime endTime')
      .lean();
    const clash = taken.filter((b) => toMinutes(b.startTime) < toMinutes(slot.endTime) && toMinutes(b.endTime) > toMinutes(slot.startTime));
    if (clash.length >= (amenity.capacity || 1)) {
      throw ApiError.conflict(`${amenity.name} is already booked on ${slot.date} between ${clash[0].startTime} and ${clash[0].endTime}`);
    }
  }
  await releaseVenue(ctx, event._id);
  return Booking.insertMany(
    slots.map((slot) => ({
      society: ctx.societyId,
      amenity: amenity._id,
      user: ctx.userId,
      ...slot,
      status: 'confirmed',
      paymentStatus: 'not_required',
      notes: `Event: ${event.title}`,
      event: event._id,
    })),
  );
}
