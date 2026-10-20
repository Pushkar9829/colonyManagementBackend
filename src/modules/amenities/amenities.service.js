import Amenity from './amenity.model.js';
import Booking from './booking.model.js';
import AmenityPayment from './amenityPayment.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { localDateString, toMinutes } from '../../common/utils/dates.js';
import { ROLES } from '../../common/constants/index.js';
import * as uploads from '../uploads/uploads.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';
import { money } from '../../common/utils/money.js';
import * as pay from './amenityPayment.service.js';
import * as passes from './passes.service.js';
import AmenityPass from './amenityPass.model.js';

const MIN = 60 * 1000;
const HOLD_MINUTES = 15; // time to finish an online payment for an instantly bookable slot
const APPROVED_HOLD_HOURS = 24; // time to pay after a manager approves a request
const isManager = (ctx) => [ROLES.ADMIN, ROLES.FACILITY_MANAGER].includes(ctx.role);
const fromMinutes = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const POPULATE = [
  { path: 'amenity', select: 'name fee deposit paymentMode cancellation' },
  { path: 'unit', select: 'label' },
  { path: 'user', select: 'name phone' },
];

const localToday = () => localDateString();
// Booking times are society-local (IST).
export const startsAt = (b) => new Date(`${b.date}T${b.startTime}:00+05:30`);
export const endsAt = (b) => new Date(`${b.date}T${b.endTime}:00+05:30`);

// Bookings that occupy a slot: requests, confirmed ones, and unpaid holds that have not lapsed.
export const holding = (now = new Date()) => ({
  $or: [{ status: { $in: ['pending', 'confirmed'] } }, { status: 'payment_pending', paymentDueAt: { $gt: now } }],
});

const needsOnlinePayment = (amenity, total) => total > 0 && amenity.paymentMode !== 'desk';
const reloadBooking = (id) => Booking.findById(id).populate(POPULATE).lean();

// ---------- amenities ----------
export function listAmenities(ctx) {
  const filter = { society: ctx.societyId };
  if (!isManager(ctx)) filter.active = true;
  return Amenity.find(filter).sort({ name: 1 }).lean();
}

export async function getAmenity(ctx, id) {
  const amenity = await Amenity.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!amenity) throw ApiError.notFound('Amenity not found');
  return amenity;
}

export async function createAmenity(ctx, data) {
  const amenity = await Amenity.create({ ...data, society: ctx.societyId });
  audit.record(ctx, 'amenity.created', 'Amenity', amenity._id, { name: amenity.name });
  return amenity;
}

export async function updateAmenity(ctx, id, data) {
  const set = { ...data };
  // nested cancellation fields are merged, not replaced
  if (data.cancellation) {
    delete set.cancellation;
    for (const [k, v] of Object.entries(data.cancellation)) set[`cancellation.${k}`] = v;
  }
  const amenity = await Amenity.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: set }, { returnDocument: 'after', runValidators: true }).lean();
  if (!amenity) throw ApiError.notFound('Amenity not found');
  audit.record(ctx, 'amenity.updated', 'Amenity', amenity._id, data);
  return amenity;
}

export async function addPhotos(ctx, id, fileIds) {
  const files = await uploads.resolve(ctx, fileIds);
  const amenity = await Amenity.findOne({ _id: id, society: ctx.societyId });
  if (!amenity) throw ApiError.notFound('Amenity not found');
  if (amenity.photos.length + files.length > 10) throw ApiError.badRequest('At most 10 photos per amenity');
  amenity.photos.push(...files);
  await amenity.save();
  return amenity.toObject();
}

export async function removePhoto(ctx, id, photoId) {
  const amenity = await Amenity.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $pull: { photos: { _id: photoId } } }, { returnDocument: 'after' }).lean();
  if (!amenity) throw ApiError.notFound('Amenity not found');
  return amenity;
}

// Slots for a day with how many places are left in each.
export async function availability(ctx, id, date) {
  const amenity = await getAmenity(ctx, id);
  const bookings = await Booking.find({ society: ctx.societyId, amenity: id, date, ...holding() }).select('startTime endTime').lean();
  const slots = [];
  const close = toMinutes(amenity.closeTime);
  for (let start = toMinutes(amenity.openTime); start + amenity.slotMinutes <= close; start += amenity.slotMinutes) {
    const end = start + amenity.slotMinutes;
    const taken = bookings.filter((b) => toMinutes(b.startTime) < end && toMinutes(b.endTime) > start).length;
    slots.push({ startTime: fromMinutes(start), endTime: fromMinutes(end), available: Math.max(0, amenity.capacity - taken) });
  }
  return { amenity: { _id: amenity._id, name: amenity.name, capacity: amenity.capacity, fee: amenity.fee, deposit: amenity.deposit }, date, slots };
}

// ---------- bookings ----------
export async function createBooking(ctx, data) {
  const amenity = await getAmenity(ctx, data.amenity);
  if (!amenity.active) throw ApiError.badRequest('This amenity is not available for booking');
  await pay.assertNotBlocked(ctx);

  const start = toMinutes(data.startTime);
  const end = toMinutes(data.endTime);
  if (start < toMinutes(amenity.openTime) || end > toMinutes(amenity.closeTime)) {
    throw ApiError.badRequest(`Bookings must be between ${amenity.openTime} and ${amenity.closeTime}`);
  }
  const today = localToday();
  if (data.date < today) throw ApiError.badRequest('Cannot book a past date');
  const maxDate = localDateString(Date.now() + amenity.advanceDays * 86400000);
  if (data.date > maxDate) throw ApiError.badRequest(`Bookings open only ${amenity.advanceDays} days in advance`);

  const sameDay = await Booking.find({ society: ctx.societyId, amenity: amenity._id, date: data.date, ...holding() }).lean();
  const overlapping = sameDay.filter((b) => toMinutes(b.startTime) < end && toMinutes(b.endTime) > start);
  if (overlapping.length >= amenity.capacity) throw ApiError.conflict('This time slot is fully booked');

  const mine = sameDay.filter((b) => (ctx.unitId ? String(b.unit) === String(ctx.unitId) : String(b.user) === String(ctx.userId)));
  if (mine.length >= amenity.maxBookingsPerUnitPerDay) {
    throw ApiError.conflict(`Limit of ${amenity.maxBookingsPerUnitPerDay} booking(s) per day reached for this amenity`);
  }

  // The fee is per slot; a booking spanning two slots pays twice.
  const slots = Math.max(1, Math.ceil((end - start) / amenity.slotMinutes));
  const fee = (amenity.fee || 0) * slots;
  const deposit = amenity.deposit || 0;
  const online = needsOnlinePayment(amenity, fee + deposit);
  let status = 'confirmed';
  if (amenity.requiresApproval) status = 'pending';
  else if (online) status = 'payment_pending';
  let paymentStatus = 'not_required';
  if (fee + deposit > 0) paymentStatus = online ? 'pending' : 'pay_at_desk';

  const booking = await Booking.create({
    ...data,
    society: ctx.societyId,
    unit: ctx.unitId || undefined,
    user: ctx.userId,
    fee,
    deposit,
    status,
    paymentStatus,
    depositStatus: deposit ? 'due' : 'none',
    paymentDueAt: status === 'payment_pending' ? new Date(Date.now() + HOLD_MINUTES * MIN) : undefined,
  });

  // Two residents can pass the capacity check at the same instant. Re-check after inserting:
  // the earliest bookings (by _id order) keep the slot, the late one is rolled back.
  const holders = await Booking.find({ society: ctx.societyId, amenity: amenity._id, date: data.date, ...holding() })
    .sort({ _id: 1 })
    .select('startTime endTime')
    .lean();
  const rank = holders
    .filter((b) => toMinutes(b.startTime) < end && toMinutes(b.endTime) > start)
    .findIndex((b) => String(b._id) === String(booking._id));
  if (rank >= amenity.capacity) {
    await Booking.deleteOne({ _id: booking._id });
    throw ApiError.conflict('This time slot was just booked by someone else');
  }

  if (amenity.requiresApproval) {
    await notifyRoles(ctx.societyId, [ROLES.ADMIN, ROLES.FACILITY_MANAGER], {
      type: 'booking',
      title: `Booking request: ${amenity.name}`,
      body: `${data.date} ${data.startTime}-${data.endTime}`,
      link: '/amenities?tab=requests',
    });
  }
  return reloadBooking(booking._id);
}

export function listBookings(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (!isManager(ctx)) filter.user = ctx.userId;
  if (filters.amenity) filter.amenity = filters.amenity;
  if (filters.status) filter.status = filters.status;
  if (filters.date) filter.date = filters.date;
  if (filters.upcoming) filter.date = { $gte: localToday() };
  if (filters.depositHeld) filter.depositStatus = 'held';
  return paginate(Booking, filter, pagination, { sort: { date: filters.upcoming ? 1 : -1, startTime: 1 }, populate: POPULATE });
}

async function loadBooking(ctx, id) {
  const filter = { _id: id, society: ctx.societyId };
  if (!isManager(ctx)) filter.user = ctx.userId;
  const booking = await Booking.findOne(filter);
  if (!booking) throw ApiError.notFound('Booking not found');
  return booking;
}

export async function getBooking(ctx, id) {
  const booking = await loadBooking(ctx, id);
  const payments = await AmenityPayment.find({ society: ctx.societyId, booking: booking._id, status: { $ne: 'created' } }).sort({ createdAt: 1 }).lean();
  return { ...(await reloadBooking(booking._id)), payments };
}

// Refund a cancellation earns. Residents follow the amenity's policy; a manager cancelling gives back everything.
export async function cancellationQuote(ctx, booking, amenity, now = new Date()) {
  const feePaid = await pay.paidTotal(ctx.societyId, { booking: booking._id }, 'fee');
  const depositPaid = await pay.paidTotal(ctx.societyId, { booking: booking._id }, 'deposit');
  const hoursBefore = (startsAt(booking) - now) / 3600000;
  const policy = amenity?.cancellation || {};
  let percent = 0;
  if (isManager(ctx)) percent = 100;
  else if (hoursBefore >= (policy.fullRefundHours ?? 24)) percent = 100;
  else if (hoursBefore >= (policy.partialRefundHours ?? 0)) percent = policy.partialRefundPercent ?? 0;
  return { feePaid, depositPaid, percent, feeRefund: Math.floor((feePaid * percent) / 100), depositRefund: depositPaid, hoursBefore: Math.round(hoursBefore * 10) / 10 };
}

export async function quote(ctx, id) {
  const booking = await loadBooking(ctx, id);
  const amenity = await Amenity.findById(booking.amenity).select('cancellation').lean();
  return cancellationQuote(ctx, booking, amenity);
}

export async function cancelBooking(ctx, id, reason) {
  const booking = await loadBooking(ctx, id);
  if (!['pending', 'confirmed', 'payment_pending'].includes(booking.status)) throw ApiError.notFound('Active booking not found');
  if (!isManager(ctx) && startsAt(booking) <= new Date()) throw ApiError.conflict('This booking has already started');
  const amenity = await Amenity.findById(booking.amenity).select('name cancellation').lean();
  const q = await cancellationQuote(ctx, booking, amenity);

  // Claim the cancellation first so two clicks cannot refund twice.
  const claimed = await Booking.findOneAndUpdate(
    { _id: booking._id, status: booking.status },
    { status: 'cancelled', cancelledAt: new Date(), cancelledBy: ctx.userId, cancelReason: reason },
    { returnDocument: 'after' },
  );
  if (!claimed) throw ApiError.conflict('Booking changed, try again');
  await AmenityPayment.updateMany({ society: ctx.societyId, booking: booking._id, status: 'created' }, { status: 'failed', notes: 'Booking cancelled' });

  const feeRefunded = await pay.refund(ctx, { booking: booking._id }, 'fee', q.feeRefund);
  const depositRefunded = await pay.refund(ctx, { booking: booking._id }, 'deposit', q.depositRefund);
  if (q.feePaid || q.depositPaid) {
    claimed.feeRefunded = feeRefunded;
    claimed.depositRefunded = depositRefunded;
    if (q.depositPaid) claimed.depositStatus = 'refunded';
    const totalPaid = q.feePaid + q.depositPaid;
    const totalRefunded = feeRefunded + depositRefunded;
    if (totalRefunded >= totalPaid) claimed.paymentStatus = 'refunded';
    else if (totalRefunded > 0) claimed.paymentStatus = 'partially_refunded';
    await claimed.save();
    audit.record(ctx, 'booking.refunded', 'Booking', booking._id, { feeRefunded, depositRefunded, percent: q.percent });
  }
  if (isManager(ctx) && String(booking.user) !== String(ctx.userId)) {
    await notifyUsers(ctx.societyId, [booking.user], {
      type: 'booking',
      title: `Booking cancelled: ${amenity?.name}`,
      body: `${booking.date} ${booking.startTime}-${booking.endTime}${reason ? ` · ${reason}` : ''}${feeRefunded + depositRefunded ? ` · ${money(feeRefunded + depositRefunded)} refunded` : ''}`,
      link: '/amenities?tab=mine',
    });
  }
  const result = await reloadBooking(booking._id);
  return { ...result, refund: { ...q, feeRefunded, depositRefunded } };
}

export async function decide(ctx, id, { approve, note }) {
  const pending = await Booking.findOne({ _id: id, society: ctx.societyId, status: 'pending' }).populate('amenity', 'name paymentMode');
  if (!pending) throw ApiError.notFound('Pending booking not found');
  let status = approve ? 'confirmed' : 'rejected';
  let paymentDueAt;
  if (approve && needsOnlinePayment(pending.amenity, pending.fee + pending.deposit)) {
    status = 'payment_pending';
    // pay within a day, but never later than the booking itself
    paymentDueAt = new Date(Math.min(Date.now() + APPROVED_HOLD_HOURS * 3600000, startsAt(pending).getTime()));
  }
  const booking = await Booking.findOneAndUpdate(
    { _id: id, society: ctx.societyId, status: 'pending' },
    { status, paymentDueAt, decidedBy: ctx.userId, decisionNote: note },
    { returnDocument: 'after' },
  )
    .populate(POPULATE)
    .lean();
  if (!booking) throw ApiError.notFound('Pending booking not found');
  const verb = { confirmed: 'confirmed', rejected: 'rejected', payment_pending: 'approved — pay to confirm' }[status];
  await notifyUsers(ctx.societyId, [booking.user._id], {
    type: 'booking',
    title: `Booking ${verb}: ${booking.amenity.name}`,
    body: `${booking.date} ${booking.startTime}-${booking.endTime}${note ? ` · ${note}` : ''}`,
    link: '/amenities?tab=mine',
  });
  return booking;
}

// ---------- payments ----------
export async function payBooking(ctx, id) {
  const booking = await loadBooking(ctx, id);
  if (booking.status !== 'payment_pending') throw ApiError.conflict(booking.status === 'pending' ? 'Wait for the booking to be approved' : 'This booking does not need payment');
  if (booking.paymentDueAt && booking.paymentDueAt <= new Date()) throw ApiError.conflict('The payment window has lapsed. Book the slot again.');
  const amenity = await Amenity.findById(booking.amenity).select('name').lean();
  const order = await pay.openOrder(ctx, {
    booking: booking._id,
    amenity: booking.amenity,
    unit: booking.unit,
    receipt: `BKG-${String(booking._id).slice(-8)}`,
    charges: [
      { kind: 'fee', amount: booking.fee, label: `${amenity.name} booking` },
      { kind: 'deposit', amount: booking.deposit, label: 'Refundable deposit' },
    ].filter((c) => c.amount > 0),
  });
  return { ...order, booking: booking._id, paymentDueAt: booking.paymentDueAt };
}

// Settles a paid booking. Called from the shared verify endpoint.
export async function confirmPaidBooking(ctx, bookingId) {
  const booking = await Booking.findOne({ _id: bookingId, society: ctx.societyId });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (booking.status === 'confirmed' && booking.paymentStatus === 'paid') return reloadBooking(booking._id);
  if (booking.status !== 'payment_pending') {
    // Paid after the hold lapsed or the booking was cancelled: give the money back.
    const fee = await pay.refund(ctx, { booking: booking._id }, 'fee', booking.fee);
    const dep = await pay.refund(ctx, { booking: booking._id }, 'deposit', booking.deposit);
    booking.paymentStatus = 'refunded';
    booking.feeRefunded = fee;
    booking.depositRefunded = dep;
    await booking.save();
    throw ApiError.conflict('This booking is no longer held, so your payment has been refunded');
  }
  booking.status = 'confirmed';
  booking.paymentStatus = 'paid';
  booking.paymentDueAt = undefined;
  if (booking.deposit) booking.depositStatus = 'held';
  await booking.save();
  return reloadBooking(booking._id);
}

// One verify endpoint for every amenity checkout: settles the order, then confirms its booking or pass.
export async function verifyPayment(ctx, body, opts) {
  const { records, alreadyPaid } = await pay.settleOrder(ctx, body, opts);
  const first = records[0];
  if (alreadyPaid) {
    // settled by the other caller (checkout verify or webhook): report the state without re-applying it
    if (first.booking) return { kind: 'booking', booking: await reloadBooking(first.booking) };
    return { kind: 'pass', pass: await AmenityPass.findById(first.pass).lean() };
  }
  if (first.booking) return { kind: 'booking', booking: await confirmPaidBooking(ctx, first.booking) };
  return { kind: 'pass', pass: await passes.activatePaidPass(ctx, first.pass) };
}

// Provider webhook: an amenity order was captured. Returns false for unknown orders.
export async function captureByOrder({ orderId, paymentId, societyId }) {
  const record = await AmenityPayment.findOne({ providerOrderId: orderId, ...(societyId ? { society: societyId } : {}) }).lean();
  if (!record) return false;
  if (record.status !== 'created' && record.status !== 'failed') return true;
  const ctx = { societyId: record.society, userId: record.user, role: ROLES.RESIDENT, unitId: record.unit, ip: 'webhook' };
  await verifyPayment(ctx, { orderId, paymentId }, { trusted: true });
  return true;
}

// Pay-at-desk bookings: the office records the money.
export async function markBookingPaid(ctx, id, { method, reference }) {
  const booking = await loadBooking(ctx, id);
  if (booking.paymentStatus !== 'pay_at_desk' && booking.paymentStatus !== 'pending') throw ApiError.conflict('Nothing is due for this booking');
  if (!['pending', 'confirmed', 'payment_pending'].includes(booking.status)) throw ApiError.conflict(`Booking is ${booking.status}`);
  await AmenityPayment.updateMany({ society: ctx.societyId, booking: booking._id, status: 'created' }, { status: 'failed', notes: 'Paid at the desk instead' });
  await pay.recordOffline(ctx, {
    booking: booking._id,
    amenity: booking.amenity,
    unit: booking.unit,
    user: booking.user,
    method,
    reference,
    charges: [{ kind: 'fee', amount: booking.fee }, { kind: 'deposit', amount: booking.deposit }],
  });
  booking.paymentStatus = 'paid';
  if (booking.deposit) booking.depositStatus = 'held';
  if (booking.status === 'payment_pending') {
    booking.status = 'confirmed';
    booking.paymentDueAt = undefined;
  }
  await booking.save();
  audit.record(ctx, 'booking.paid_at_desk', 'Booking', booking._id, { amount: booking.fee + booking.deposit, method });
  return reloadBooking(booking._id);
}

// After the event the manager returns the deposit, minus any deduction for damage.
export async function refundDeposit(ctx, id, { amount, reason }) {
  const booking = await loadBooking(ctx, id);
  if (booking.depositStatus !== 'held') throw ApiError.conflict('No deposit is held for this booking');
  if (endsAt(booking) > new Date()) throw ApiError.conflict('Deposits are refunded after the booking has ended');
  const held = await pay.paidTotal(ctx.societyId, { booking: booking._id }, 'deposit');
  const toRefund = amount ?? held;
  if (toRefund > held) throw ApiError.badRequest(`At most ${money(held)} can be refunded`);
  if (toRefund < held && !reason) throw ApiError.badRequest('Give a reason for the deduction');
  const refunded = await pay.refund(ctx, { booking: booking._id }, 'deposit', toRefund);
  booking.depositRefunded = refunded;
  booking.depositNote = reason;
  if (refunded === 0) booking.depositStatus = 'forfeited';
  else booking.depositStatus = refunded < held ? 'partially_refunded' : 'refunded';
  await booking.save();
  audit.record(ctx, 'booking.deposit_refunded', 'Booking', booking._id, { refunded, deducted: held - refunded, reason });
  await notifyUsers(ctx.societyId, [booking.user], {
    type: 'booking',
    title: refunded ? `Deposit of ${money(refunded)} refunded` : 'Deposit withheld',
    body: reason || 'Thank you for taking care of the facility',
    link: '/amenities?tab=mine',
  });
  return reloadBooking(booking._id);
}

export async function markAttendance(ctx, id, attended) {
  const booking = await loadBooking(ctx, id);
  if (booking.status !== 'confirmed') throw ApiError.conflict('Only confirmed bookings can be marked');
  if (startsAt(booking) > new Date()) throw ApiError.conflict('The booking has not started yet');
  booking.attendance = attended ? 'attended' : 'no_show';
  booking.attendanceMarkedBy = ctx.userId;
  await booking.save();
  return reloadBooking(booking._id);
}

// ---------- scheduled ----------
// Lapsed online-payment holds release their slot.
export async function expireHolds(now = new Date()) {
  const stale = await Booking.find({ status: 'payment_pending', paymentDueAt: { $lte: now } }).select('_id society user').limit(2000).lean();
  if (!stale.length) return { expired: 0 };
  const ids = stale.map((b) => b._id);
  await Booking.updateMany({ _id: { $in: ids }, status: 'payment_pending' }, { status: 'cancelled', cancelledAt: now, cancelReason: 'Payment not completed in time' });
  await AmenityPayment.updateMany({ booking: { $in: ids }, status: 'created' }, { status: 'failed', notes: 'Payment window lapsed' });
  return { expired: stale.length };
}
