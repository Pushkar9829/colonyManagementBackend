import crypto from 'node:crypto';
import Event from './event.model.js';
import EventRsvp from './eventRsvp.model.js';
import EventTicket from './eventTicket.model.js';
import Amenity from '../amenities/amenity.model.js';
import { releaseVenue, reserveVenue } from './venue.js';
import ApiError from '../../common/errors/ApiError.js';
import { audienceFilter, audienceUserIds } from '../../common/utils/audience.js';
import { randomCode } from '../../common/utils/codes.js';
import { addHours } from '../../common/utils/dates.js';
import { money } from '../../common/utils/money.js';
import { nextNumber } from '../counter/counter.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import { mockProvider, provider } from '../payments/providers.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { isModerator, memberSummaries, sameId } from '../directory/members.js';

const page = (items, total, { page: p, limit }) => ({ items, meta: { page: p, limit, total, pages: Math.ceil(total / limit) || 1 } });
const SEAT_STATES = ['confirmed', 'waitlisted'];
const link = (id) => `/events/${id}`;

// ---------------- seats ----------------

// Atomically takes (delta > 0) or returns (delta < 0) seats. Taking fails when it would exceed capacity.
async function adjustSeats(eventId, delta) {
  if (!delta) return true;
  const filter = { _id: eventId };
  if (delta > 0) filter.$or = [{ capacity: null }, { $expr: { $lte: [{ $add: ['$goingCount', delta] }, '$capacity'] } }];
  const res = await Event.updateOne(filter, { $inc: { goingCount: delta } });
  return res.modifiedCount === 1;
}

// Moves waitlisted RSVPs (oldest first) into free seats. A party that doesn't fit is skipped so
// a smaller one behind it can still get in; it keeps its place for the next opening.
export async function promoteWaitlist(eventId) {
  const event = await Event.findById(eventId).lean();
  if (!event || event.status !== 'scheduled' || new Date(event.startAt) <= new Date()) return [];
  const waiting = await EventRsvp.find({ society: event.society, event: event._id, state: 'waitlisted' }).sort({ waitlistedAt: 1, _id: 1 }).lean();
  const promoted = [];
  for (const r of waiting) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await adjustSeats(event._id, r.headcount))) continue;
    // eslint-disable-next-line no-await-in-loop
    const flipped = await EventRsvp.findOneAndUpdate({ _id: r._id, state: 'waitlisted' }, { state: 'confirmed', $unset: { waitlistedAt: 1 } }, { returnDocument: 'after' }).lean();
    if (!flipped) {
      // changed meanwhile (cancelled / promoted elsewhere): give the seats back
      // eslint-disable-next-line no-await-in-loop
      await adjustSeats(event._id, -r.headcount);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await Event.updateOne({ _id: event._id }, { $inc: { waitlistCount: -1 } });
    promoted.push(flipped);
  }
  if (promoted.length) {
    for (const r of promoted) {
      // eslint-disable-next-line no-await-in-loop
      await notifyUsers(event.society, [r.user], {
        type: 'event',
        title: `You're in: ${event.title}`,
        body: `A spot opened up and your RSVP for ${r.headcount} is confirmed.${r.amountDue ? ` Amount due ${money(r.amountDue)}.` : ''}`,
        link: link(event._id),
      });
    }
    invalidate(event.society, ['events']);
  }
  return promoted;
}

// ---------------- presenting ----------------

const isOpenForRsvp = (e, now = new Date()) => e.status === 'scheduled' && now < new Date(e.rsvpDeadline || e.startAt);

function presentEvent(ctx, e, myRsvp) {
  const out = {
    ...e,
    gallery: (e.gallery || []).map((p) => ({ ...p, isMine: sameId(p.by, ctx.userId) })),
    seatsLeft: e.capacity ? Math.max(0, e.capacity - e.goingCount) : null,
    isFull: Boolean(e.capacity && e.goingCount >= e.capacity),
    rsvpOpen: isOpenForRsvp(e),
    isPast: new Date(e.endAt) < new Date(),
    myRsvp: myRsvp ? presentRsvp(myRsvp) : null,
  };
  return out;
}

function presentRsvp(r) {
  const { society, ...rest } = r;
  return rest;
}

// Organisers see every event; everyone else only events whose audience includes them.
async function visibleFilter(ctx) {
  return { society: ctx.societyId, ...(isModerator(ctx) ? {} : await audienceFilter(ctx)) };
}

async function loadEvent(ctx, id) {
  const event = await Event.findOne({ _id: id, ...(await visibleFilter(ctx)) });
  if (!event) throw ApiError.notFound('Event not found');
  return event;
}

// ---------------- events ----------------

async function checkAmenity(ctx, amenityId) {
  if (!amenityId) return null;
  const amenity = await Amenity.findOne({ _id: amenityId, society: ctx.societyId }).select('name').lean();
  if (!amenity) throw ApiError.badRequest('Amenity not found');
  return amenity;
}

function checkTimes({ startAt, endAt, rsvpDeadline }) {
  if (endAt <= startAt) throw ApiError.validation([{ field: 'body.endAt', message: 'End must be after the start' }]);
  if (rsvpDeadline && rsvpDeadline > startAt) throw ApiError.validation([{ field: 'body.rsvpDeadline', message: 'RSVP deadline must be before the event starts' }]);
}

export async function create(ctx, data) {
  checkTimes(data);
  if (data.startAt < new Date()) throw ApiError.validation([{ field: 'body.startAt', message: 'Start time is in the past' }]);
  const amenity = await checkAmenity(ctx, data.amenity);
  const [cover] = await uploads.resolve(ctx, data.cover ? [data.cover] : []);
  if (cover && !cover.mimetype.startsWith('image/')) throw ApiError.badRequest('Cover must be an image');
  const event = await Event.create({
    ...data,
    cover,
    venue: data.venue || amenity?.name,
    society: ctx.societyId,
    createdBy: ctx.userId,
  });
  try {
    await reserveVenue(ctx, event);
  } catch (err) {
    await Event.deleteOne({ _id: event._id }); // don't leave an event whose venue is double-booked
    throw err;
  }
  const recipients = (await audienceUserIds(ctx.societyId, event.audience)).filter((id) => !sameId(id, ctx.userId));
  await notifyUsers(ctx.societyId, recipients, {
    type: 'event',
    title: `New event: ${event.title}`,
    body: `${event.startAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}${event.venue ? ` · ${event.venue}` : ''}`,
    link: link(event._id),
  });
  audit.record(ctx, 'event.created', 'Event', event._id, { title: event.title });
  invalidate(ctx.societyId, ['events']);
  return getById(ctx, event._id);
}

export async function list(ctx, filters, pagination) {
  const filter = await visibleFilter(ctx);
  if (filters.from || filters.to) {
    // anything overlapping the window (calendar month grid)
    if (filters.to) filter.startAt = { $lt: filters.to };
    if (filters.from) filter.endAt = { $gte: filters.from };
  } else if (filters.when === 'past') {
    filter.endAt = { $lt: new Date() };
  } else {
    filter.endAt = { $gte: new Date() };
  }
  if (filters.status) filter.status = filters.status;
  const sort = filters.when === 'past' ? { startAt: -1 } : { startAt: 1 };
  const [rows, total] = await Promise.all([
    Event.find(filter).select('-gallery').sort(sort).skip(pagination.skip).limit(pagination.limit).lean(),
    Event.countDocuments(filter),
  ]);
  const mine = await EventRsvp.find({ society: ctx.societyId, user: ctx.userId, event: { $in: rows.map((r) => r._id) } }).lean();
  const byEvent = new Map(mine.map((r) => [String(r.event), r]));
  return page(rows.map((e) => presentEvent(ctx, e, byEvent.get(String(e._id)))), total, pagination);
}

export async function getById(ctx, id) {
  const event = await loadEvent(ctx, id);
  const e = event.toObject();
  const myRsvp = await EventRsvp.findOne({ society: ctx.societyId, event: e._id, user: ctx.userId }).lean();
  const out = presentEvent(ctx, e, myRsvp);
  const counts = await EventRsvp.aggregate([
    { $match: { society: ctx.societyId, event: e._id } },
    { $group: { _id: '$state', rsvps: { $sum: 1 }, people: { $sum: '$headcount' }, checkedIn: { $sum: { $cond: [{ $ifNull: ['$checkedInAt', false] }, 1, 0] } } } },
  ]);
  const by = Object.fromEntries(counts.map((c) => [c._id, c]));
  out.counts = { going: by.confirmed?.people || 0, waitlisted: by.waitlisted?.rsvps || 0, maybe: by.maybe?.rsvps || 0, declined: by.declined?.rsvps || 0 };
  if (isModerator(ctx)) {
    out.counts.checkedIn = by.confirmed?.checkedIn || 0;
    const [collected] = await EventTicket.aggregate([{ $match: { society: ctx.societyId, event: e._id, status: 'success' } }, { $group: { _id: null, amount: { $sum: '$amount' } } }]);
    out.counts.collected = collected?.amount || 0;
  }
  const people = await memberSummaries(ctx.societyId, [e.createdBy, ...(e.gallery || []).map((p) => p.by)]);
  out.createdBy = people.get(String(e.createdBy)) || null;
  out.gallery = out.gallery.map((p) => ({ ...p, by: people.get(String(p.by)) || { _id: p.by, name: 'Member' } }));
  return out;
}

export async function update(ctx, id, data) {
  const event = await Event.findOne({ _id: id, society: ctx.societyId });
  if (!event) throw ApiError.notFound('Event not found');
  if (event.status === 'cancelled') throw ApiError.conflict('This event was cancelled');
  const next = {
    startAt: data.startAt || event.startAt,
    endAt: data.endAt || event.endAt,
    rsvpDeadline: data.rsvpDeadline === undefined ? event.rsvpDeadline : data.rsvpDeadline,
  };
  checkTimes(next);
  if (data.capacity && data.capacity < event.goingCount) {
    throw ApiError.conflict(`Capacity can't be lower than the ${event.goingCount} people already confirmed`);
  }
  if (data.ticketPrice !== undefined && data.ticketPrice !== event.ticketPrice) {
    if (await EventTicket.exists({ society: ctx.societyId, event: event._id, status: 'success' })) {
      throw ApiError.conflict('Ticket price is locked once someone has paid');
    }
  }
  if (data.amenity) {
    const amenity = await checkAmenity(ctx, data.amenity);
    if (!data.venue && !event.venue) data.venue = amenity.name;
  }
  if (data.cover) {
    const [cover] = await uploads.resolve(ctx, [data.cover]);
    if (!cover.mimetype.startsWith('image/')) throw ApiError.badRequest('Cover must be an image');
    data.cover = cover;
  }
  const moved = (data.startAt && +data.startAt !== +event.startAt) || (data.venue && data.venue !== event.venue);
  const venueChanged = ['amenity', 'startAt', 'endAt'].some((k) => k in data);
  if (venueChanged) {
    // reserve the new slot first: on a clash nothing is saved and the old reservation stays
    await reserveVenue(ctx, { _id: event._id, title: data.title || event.title, status: event.status, amenity: 'amenity' in data ? data.amenity : event.amenity, startAt: data.startAt || event.startAt, endAt: data.endAt || event.endAt });
  }
  Object.assign(event, data);
  if (data.capacity === null) event.capacity = undefined;
  if (data.startAt) event.reminderSentAt = undefined; // re-arm the 24h reminder for the new time
  await event.save();

  if (data.ticketPrice !== undefined) {
    // re-price unpaid RSVPs
    const rsvps = await EventRsvp.find({ society: ctx.societyId, event: event._id, state: { $in: SEAT_STATES }, paymentStatus: { $ne: 'paid' } });
    for (const r of rsvps) {
      r.amountDue = r.headcount * event.ticketPrice;
      r.paymentStatus = r.amountDue ? 'pending' : 'not_required';
      if (!r.amountDue) r.paymentMode = 'none';
      else if (r.paymentMode === 'none') r.paymentMode = 'venue';
      // eslint-disable-next-line no-await-in-loop
      await r.save();
    }
  }
  if (moved) {
    const going = await EventRsvp.find({ society: ctx.societyId, event: event._id, state: { $in: ['confirmed', 'waitlisted', 'maybe'] } }).select('user').lean();
    await notifyUsers(ctx.societyId, going.map((r) => r.user), { type: 'event', title: `Updated: ${event.title}`, body: 'The time or venue changed. Check the details.', link: link(event._id) });
  }
  await promoteWaitlist(event._id); // capacity may have grown
  audit.record(ctx, 'event.updated', 'Event', event._id, { fields: Object.keys(data) });
  invalidate(ctx.societyId, ['events']);
  return getById(ctx, event._id);
}

export async function cancel(ctx, id, { reason }) {
  const event = await Event.findOne({ _id: id, society: ctx.societyId });
  if (!event) throw ApiError.notFound('Event not found');
  if (event.status === 'cancelled') throw ApiError.conflict('Already cancelled');
  event.status = 'cancelled';
  event.cancelReason = reason;
  await event.save();
  await releaseVenue(ctx, event._id);
  const affected = await EventRsvp.find({ society: ctx.societyId, event: event._id, state: { $in: ['confirmed', 'waitlisted', 'maybe'] } }).lean();
  await EventRsvp.updateMany({ society: ctx.societyId, event: event._id, paymentStatus: 'paid' }, { paymentStatus: 'refund_due' });
  await EventRsvp.updateMany({ society: ctx.societyId, event: event._id, state: { $in: SEAT_STATES } }, { state: 'cancelled' });
  await notifyUsers(ctx.societyId, affected.map((r) => r.user), {
    type: 'event',
    title: `Cancelled: ${event.title}`,
    body: reason || 'The organisers cancelled this event.',
    link: link(event._id),
    channels: ['inapp', 'push', 'email'],
  });
  audit.record(ctx, 'event.cancelled', 'Event', event._id, { reason, attendees: affected.length });
  invalidate(ctx.societyId, ['events']);
  return getById(ctx, event._id);
}

// ---------------- RSVP ----------------

async function newTicketCode(societyId) {
  for (let i = 0; i < 5; i += 1) {
    const code = randomCode(8);
    // eslint-disable-next-line no-await-in-loop
    if (!(await EventRsvp.exists({ society: societyId, ticketCode: code }))) return code;
  }
  return `${randomCode(6)}${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

function paymentFields(event, headcount, existing, mode) {
  const amountDue = headcount * event.ticketPrice;
  if (!amountDue) return { amountDue: 0, paymentMode: 'none', paymentStatus: 'not_required' };
  const paymentMode = mode && mode !== 'none' ? mode : existing?.paymentMode && existing.paymentMode !== 'none' ? existing.paymentMode : 'venue';
  if (paymentMode === 'online' && !event.allowOnlinePayment) throw ApiError.badRequest('This event takes payment at the venue only');
  return { amountDue, paymentMode, paymentStatus: 'pending' };
}

export async function rsvp(ctx, id, { response, guests = 0, paymentMode }) {
  const event = (await loadEvent(ctx, id)).toObject();
  if (event.status !== 'scheduled') throw ApiError.conflict('This event was cancelled');
  if (!isOpenForRsvp(event)) throw ApiError.conflict('RSVPs are closed for this event');
  if (guests > event.maxGuests) throw ApiError.badRequest(`You can bring at most ${event.maxGuests} guest${event.maxGuests === 1 ? '' : 's'}`);

  const headcount = response === 'yes' ? 1 + guests : 1;
  const existing = await EventRsvp.findOne({ society: ctx.societyId, event: event._id, user: ctx.userId }).lean();
  if (existing?.paymentStatus === 'paid' && (response !== 'yes' || headcount !== existing.headcount)) {
    throw ApiError.conflict('Your ticket is already paid. Contact the organiser to change it.');
  }

  let state;
  let freedSeats = false;
  let waitlistedAt = existing?.waitlistedAt;
  if (existing?.state === 'confirmed' && response === 'yes') {
    // keep my seats, just change the party size
    const delta = headcount - existing.headcount;
    if (!(await adjustSeats(event._id, delta))) {
      const fresh = await Event.findById(event._id).select('capacity goingCount').lean();
      throw ApiError.conflict(`Only ${Math.max(0, fresh.capacity - fresh.goingCount)} more seat(s) available`);
    }
    state = 'confirmed';
    freedSeats = delta < 0;
  } else {
    if (existing?.state === 'confirmed') {
      await adjustSeats(event._id, -existing.headcount);
      freedSeats = true;
    }
    if (existing?.state === 'waitlisted') await Event.updateOne({ _id: event._id }, { $inc: { waitlistCount: -1 } });
    if (response === 'yes') {
      // while people are waiting, new RSVPs join the waitlist and are seated in queue order
      const queueEmpty = existing?.state !== 'waitlisted' && !(await Event.exists({ _id: event._id, waitlistCount: { $gt: 0 } }));
      if (queueEmpty && (await adjustSeats(event._id, headcount))) {
        state = 'confirmed';
        waitlistedAt = undefined;
      } else {
        state = 'waitlisted';
        // changing party size while waitlisted keeps the original place in the queue
        waitlistedAt = existing?.state === 'waitlisted' ? existing.waitlistedAt : new Date();
        await Event.updateOne({ _id: event._id }, { $inc: { waitlistCount: 1 } });
      }
    } else {
      state = response === 'maybe' ? 'maybe' : 'declined';
      waitlistedAt = undefined;
    }
  }

  const pay = SEAT_STATES.includes(state)
    ? existing?.paymentStatus === 'paid'
      ? { amountDue: existing.amountDue, paymentMode: existing.paymentMode, paymentStatus: 'paid' }
      : paymentFields(event, headcount, existing, paymentMode)
    : { amountDue: 0, paymentMode: 'none', paymentStatus: existing?.paymentStatus === 'paid' ? 'paid' : 'not_required' };

  const set = { response, guests: response === 'yes' ? guests : 0, headcount, state, ...pay, unit: ctx.unitId || undefined };
  const update = waitlistedAt ? { $set: { ...set, waitlistedAt } } : { $set: set, $unset: { waitlistedAt: 1 } };
  if (!existing) update.$setOnInsert = { ticketCode: await newTicketCode(ctx.societyId) };
  const saved = await EventRsvp.findOneAndUpdate({ society: ctx.societyId, event: event._id, user: ctx.userId }, update, { upsert: true, returnDocument: 'after' }).lean();

  // a smaller party may now fit, or seats were given back
  if (freedSeats || state === 'waitlisted') {
    const promoted = await promoteWaitlist(event._id);
    if (promoted.some((r) => sameId(r._id, saved._id))) saved.state = 'confirmed';
  }
  invalidate(ctx.societyId, ['events']);
  return presentRsvp(saved);
}

export const cancelRsvp = (ctx, id) => rsvp(ctx, id, { response: 'no' });

export async function myTicket(ctx, id) {
  const event = await loadEvent(ctx, id);
  const r = await EventRsvp.findOne({ society: ctx.societyId, event: event._id, user: ctx.userId, state: 'confirmed' }).lean();
  if (!r) throw ApiError.notFound('You have no confirmed ticket for this event');
  const [holder] = (await memberSummaries(ctx.societyId, [ctx.userId])).values();
  return {
    ...presentRsvp(r),
    holder,
    event: { _id: event._id, title: event.title, startAt: event.startAt, endAt: event.endAt, venue: event.venue },
    // what the organiser's scanner reads
    qrPayload: `colonyhub:event:${event._id}:${r.ticketCode}`,
  };
}

export async function listRsvps(ctx, id, { state, search }, pagination) {
  const event = await Event.findOne({ _id: id, society: ctx.societyId }).select('_id').lean();
  if (!event) throw ApiError.notFound('Event not found');
  const filter = { society: ctx.societyId, event: event._id };
  if (state) filter.state = state;
  const rows = await EventRsvp.find(filter).sort({ state: 1, waitlistedAt: 1, createdAt: 1 }).lean();
  const people = await memberSummaries(ctx.societyId, rows.map((r) => r.user));
  let items = rows.map((r) => ({ ...presentRsvp(r), user: people.get(String(r.user)) || { _id: r.user, name: 'Former member', units: [] } }));
  if (search) {
    const q = search.toLowerCase();
    items = items.filter((r) => r.user.name.toLowerCase().includes(q) || r.user.units.some((u) => u.toLowerCase().includes(q)) || r.ticketCode === search.toUpperCase());
  }
  const total = items.length;
  return page(items.slice(pagination.skip, pagination.skip + pagination.limit), total, pagination);
}

// ---------------- payments ----------------

async function settleTicket(ctx, ticket, rsvpDoc) {
  ticket.status = 'success';
  ticket.paidAt = ticket.paidAt || new Date();
  ticket.receiptNumber = await nextNumber(ctx.societyId, 'eventTicket', 'EVT');
  await ticket.save();
  const r = await EventRsvp.findOneAndUpdate(
    { _id: rsvpDoc._id },
    { paymentStatus: SEAT_STATES.includes(rsvpDoc.state) ? 'paid' : 'refund_due', paymentMode: ticket.method === 'online' ? 'online' : 'venue' },
    { returnDocument: 'after' },
  ).lean();
  if (r.paymentStatus === 'refund_due') audit.record(ctx, 'eventTicket.refund_required', 'EventTicket', ticket._id, { reason: 'RSVP no longer holds seats' });
  audit.record(ctx, 'eventTicket.paid', 'EventTicket', ticket._id, { amount: ticket.amount, method: ticket.method, event: String(ticket.event) });
  return r;
}

export async function createOrder(ctx, id) {
  const event = await loadEvent(ctx, id);
  if (event.status !== 'scheduled') throw ApiError.conflict('This event was cancelled');
  if (!event.allowOnlinePayment) throw ApiError.badRequest('This event takes payment at the venue only');
  const r = await EventRsvp.findOne({ society: ctx.societyId, event: event._id, user: ctx.userId }).lean();
  if (!r || r.state !== 'confirmed') throw ApiError.conflict('Confirm your RSVP before paying');
  if (r.paymentStatus !== 'pending' || !r.amountDue) throw ApiError.conflict(r.paymentStatus === 'paid' ? 'Already paid' : 'Nothing to pay');
  const order = await provider.createOrder({ amount: r.amountDue, receipt: `EVT-${r.ticketCode}`, notes: { event: String(event._id), rsvp: String(r._id) } });
  await EventTicket.create({
    society: ctx.societyId,
    event: event._id,
    rsvp: r._id,
    user: ctx.userId,
    amount: r.amountDue,
    method: 'online',
    provider: provider.name,
    providerOrderId: order.orderId,
    status: 'created',
  });
  await EventRsvp.updateOne({ _id: r._id }, { paymentMode: 'online' });
  return { ...order, provider: provider.name, title: event.title };
}

// `trusted`: called from the provider webhook, which already proved the capture.
export async function verifyPayment(ctx, { orderId, paymentId, signature }, { trusted = false } = {}) {
  const ticket = await EventTicket.findOne({ society: ctx.societyId, providerOrderId: orderId, user: ctx.userId });
  if (!ticket) throw ApiError.notFound('Order not found');
  const r = await EventRsvp.findById(ticket.rsvp).lean();
  if (ticket.status === 'success') return { ticket: ticket.toObject(), rsvp: presentRsvp(r) }; // idempotent
  if (!trusted && !(await provider.verify({ orderId, paymentId, signature }))) {
    ticket.status = 'failed';
    await ticket.save();
    throw ApiError.badRequest('Payment verification failed');
  }
  // Claim the ticket so a checkout verify racing the webhook settles it once.
  const claimed = await EventTicket.findOneAndUpdate(
    { _id: ticket._id, status: { $in: ['created', 'failed'] }, providerPaymentId: { $exists: false } },
    { providerPaymentId: paymentId },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    const current = await EventTicket.findById(ticket._id).lean();
    return { ticket: current, rsvp: presentRsvp(await EventRsvp.findById(ticket.rsvp).lean()) };
  }
  ticket.providerPaymentId = paymentId;
  ticket.paidAt = new Date();
  const updated = await settleTicket(ctx, ticket, r);
  invalidate(ctx.societyId, ['events'], { roles: ['facility_manager'] });
  return { ticket: ticket.toObject(), rsvp: presentRsvp(updated) };
}

// Provider webhook: an event ticket order was captured. Returns false for unknown orders.
export async function captureByOrder({ orderId, paymentId }) {
  const ticket = await EventTicket.findOne({ providerOrderId: orderId }).lean();
  if (!ticket) return false;
  if (ticket.status === 'created' || ticket.status === 'failed') {
    const ctx = { societyId: ticket.society, userId: ticket.user, role: 'resident', unitId: null, ip: 'webhook' };
    await verifyPayment(ctx, { orderId, paymentId }, { trusted: true });
  }
  return true;
}

// Dev-only stand-in for the provider checkout (mirrors /payments/mock/sign).
export function mockSign(orderId) {
  if (provider.name !== 'mock') throw ApiError.notFound();
  const paymentId = `mock_pay_${crypto.randomBytes(8).toString('hex')}`;
  return { orderId, paymentId, signature: mockProvider.sign(orderId, paymentId) };
}

// Organiser records money collected at the venue.
export async function collectAtVenue(ctx, eventId, rsvpId, { method }) {
  const r = await EventRsvp.findOne({ _id: rsvpId, society: ctx.societyId, event: eventId }).lean();
  if (!r) throw ApiError.notFound('RSVP not found');
  if (r.state !== 'confirmed') throw ApiError.conflict('Only confirmed RSVPs can pay');
  if (r.paymentStatus !== 'pending') throw ApiError.conflict(r.paymentStatus === 'paid' ? 'Already paid' : 'Nothing to collect');
  const ticket = new EventTicket({ society: ctx.societyId, event: r.event, rsvp: r._id, user: r.user, amount: r.amountDue, method, recordedBy: ctx.userId, status: 'created' });
  const updated = await settleTicket(ctx, ticket, r);
  return { ticket: ticket.toObject(), rsvp: presentRsvp(updated) };
}

export async function listTickets(ctx, eventId, pagination) {
  const filter = { society: ctx.societyId, event: eventId, status: 'success' };
  const [rows, total] = await Promise.all([
    EventTicket.find(filter).sort({ paidAt: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
    EventTicket.countDocuments(filter),
  ]);
  const people = await memberSummaries(ctx.societyId, rows.flatMap((t) => [t.user, t.recordedBy]));
  return page(rows.map((t) => ({ ...t, user: people.get(String(t.user)) || null, recordedBy: t.recordedBy ? people.get(String(t.recordedBy)) || null : null })), total, pagination);
}

// ---------------- check-in ----------------

// By ticket code (scanned QR or typed) or RSVP id (tapped in the attendee list).
export async function checkIn(ctx, eventId, { code, rsvpId, attendedCount, collect }) {
  const event = await Event.findOne({ _id: eventId, society: ctx.societyId }).lean();
  if (!event) throw ApiError.notFound('Event not found');
  if (event.status !== 'scheduled') throw ApiError.conflict('This event was cancelled');
  let ticketCode = code?.trim().toUpperCase();
  // accept the full QR payload too
  const m = /^colonyhub:event:([a-f0-9]{24}):([A-Z0-9]+)$/i.exec(code?.trim() || '');
  if (m) {
    if (m[1] !== String(event._id)) throw ApiError.badRequest('This ticket is for a different event');
    ticketCode = m[2].toUpperCase();
  }
  const filter = { society: ctx.societyId, event: event._id, ...(rsvpId ? { _id: rsvpId } : { ticketCode }) };
  const r = await EventRsvp.findOne(filter).lean();
  if (!r) throw ApiError.notFound('Ticket not found for this event');
  if (r.state !== 'confirmed') throw ApiError.conflict(r.state === 'waitlisted' ? 'This RSVP is still on the waitlist' : 'This RSVP is not confirmed');
  if (r.checkedInAt) throw ApiError.conflict(`Already checked in at ${new Date(r.checkedInAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', timeStyle: 'short' })}`);
  let current = r;
  if (r.paymentStatus === 'pending') {
    if (!collect) throw new ApiError(409, 'PAYMENT_PENDING', `Payment of ${money(r.amountDue)} is pending`, { amountDue: r.amountDue, rsvp: r._id });
    current = (await collectAtVenue(ctx, event._id, r._id, { method: collect })).rsvp;
  }
  const updated = await EventRsvp.findOneAndUpdate(
    { _id: r._id, checkedInAt: null },
    { checkedInAt: new Date(), checkedInBy: ctx.userId, attendedCount: Math.min(attendedCount || r.headcount, r.headcount) },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw ApiError.conflict('Already checked in');
  const people = await memberSummaries(ctx.societyId, [r.user]);
  return { ...presentRsvp({ ...current, ...updated }), user: people.get(String(r.user)) || null };
}

export async function undoCheckIn(ctx, eventId, rsvpId) {
  const r = await EventRsvp.findOneAndUpdate(
    { _id: rsvpId, society: ctx.societyId, event: eventId, checkedInAt: { $ne: null } },
    { $unset: { checkedInAt: 1, checkedInBy: 1, attendedCount: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!r) throw ApiError.notFound('Checked-in RSVP not found');
  return presentRsvp(r);
}

// ---------------- gallery ----------------

export async function addPhotos(ctx, id, { photos: ids }) {
  const event = await loadEvent(ctx, id);
  if (new Date(event.startAt) > new Date()) throw ApiError.conflict('Photos can be added once the event has started');
  if (!isModerator(ctx)) {
    const attended = await EventRsvp.exists({ society: ctx.societyId, event: event._id, user: ctx.userId, state: 'confirmed' });
    if (!attended) throw ApiError.forbidden('Only attendees and organisers can add photos');
  }
  const photos = await uploads.resolve(ctx, ids);
  if (photos.some((p) => !p.mimetype.startsWith('image/'))) throw ApiError.badRequest('Only images can be added to the gallery');
  if (event.gallery.length + photos.length > 200) throw ApiError.badRequest('The gallery is full (200 photos)');
  event.gallery.push(...photos.map((p) => ({ ...p, by: ctx.userId, at: new Date() })));
  await event.save();
  return getById(ctx, event._id);
}

export async function removePhoto(ctx, id, photoId) {
  const event = await loadEvent(ctx, id);
  const photo = event.gallery.id(photoId);
  if (!photo) throw ApiError.notFound('Photo not found');
  if (!sameId(photo.by, ctx.userId) && !isModerator(ctx)) throw ApiError.forbidden();
  photo.deleteOne();
  await event.save();
  return getById(ctx, event._id);
}

// ---------------- jobs ----------------

// 24 hours before the start: remind everyone going (and the maybes).
export async function sendReminders(now = new Date()) {
  const due = await Event.find({ status: 'scheduled', reminderSentAt: null, startAt: { $gt: now, $lte: addHours(now, 24) } }).select('_id').limit(200).lean();
  let reminded = 0;
  for (const { _id } of due) {
    // eslint-disable-next-line no-await-in-loop
    const event = await Event.findOneAndUpdate({ _id, reminderSentAt: null }, { reminderSentAt: now }, { returnDocument: 'after' }).lean();
    if (!event) continue; // another instance took it
    // eslint-disable-next-line no-await-in-loop
    const rsvps = await EventRsvp.find({ society: event.society, event: event._id, state: { $in: ['confirmed', 'maybe'] } }).select('user state paymentStatus amountDue').lean();
    const when = new Date(event.startAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: 'numeric', minute: '2-digit' });
    for (const r of rsvps) {
      // eslint-disable-next-line no-await-in-loop
      await notifyUsers(event.society, [r.user], {
        type: 'event',
        title: `Tomorrow: ${event.title}`,
        body: `${when}${event.venue ? ` at ${event.venue}` : ''}.${r.state === 'maybe' ? ' Still deciding? Update your RSVP.' : ''}${r.paymentStatus === 'pending' ? ` ${money(r.amountDue)} due.` : ''}`,
        link: link(event._id),
      });
    }
    reminded += rsvps.length;
  }
  return { events: due.length, reminded };
}
