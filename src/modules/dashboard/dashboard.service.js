import Unit from '../units/unit.model.js';
import Membership from '../users/membership.model.js';
import Visitor from '../visitors/visitor.model.js';
import DailyHelp from '../dailyHelp/dailyHelp.model.js';
import SosAlert from '../sos/sos.model.js';
import Complaint from '../complaints/complaint.model.js';
import Bill from '../billing/bill.model.js';
import Booking from '../amenities/booking.model.js';
import Poll from '../polls/poll.model.js';
import Notice from '../notices/notice.model.js';
import { ROLES } from '../../common/constants/index.js';
import { localDateString, localPeriod, startOfLocalDay } from '../../common/utils/dates.js';
import { audienceFilter } from '../../common/utils/audience.js';
import * as billing from '../billing/billing.service.js';
import * as complaints from '../complaints/complaints.service.js';
import * as gates from '../gates/gates.service.js';

const ACTIVE_COMPLAINT = ['open', 'assigned', 'in_progress', 'on_hold', 'reopened'];
const currentPeriod = () => localPeriod();
const localToday = () => localDateString();

async function management(ctx) {
  const s = ctx.societyId;
  const today = startOfLocalDay();
  const [units, occupancy, residents, pendingApprovals, visitorsToday, insideNow, activeSos, complaintStats, billingMonth, billingAll, bookingsToday, recentVisitors] =
    await Promise.all([
      Unit.countDocuments({ society: s }),
      Unit.aggregate([{ $match: { society: s } }, { $group: { _id: '$occupancy', count: { $sum: 1 } } }]),
      Membership.countDocuments({ society: s, role: ROLES.RESIDENT, status: 'active' }),
      Membership.countDocuments({ society: s, status: 'pending' }),
      Visitor.countDocuments({ society: s, createdAt: { $gte: today } }),
      Visitor.countDocuments({ society: s, status: 'checked_in' }),
      SosAlert.countDocuments({ society: s, status: { $ne: 'resolved' } }),
      complaints.stats(ctx),
      billing.summary(ctx, currentPeriod()),
      billing.summary(ctx),
      Booking.countDocuments({ society: s, date: localToday(), status: 'confirmed' }),
      Visitor.find({ society: s }).sort({ createdAt: -1 }).limit(5).populate('unit', 'label').select('name purpose status createdAt unit entryGateName exitGateName').lean(),
    ]);
  return {
    units,
    occupancy: Object.fromEntries(occupancy.map((o) => [o._id, o.count])),
    residents,
    pendingApprovals,
    visitorsToday,
    insideNow,
    activeSos,
    complaints: complaintStats,
    billing: { month: billingMonth, period: currentPeriod(), allTime: billingAll },
    bookingsToday,
    recentVisitors,
  };
}

async function guard(ctx) {
  const s = ctx.societyId;
  // The guard's gate (chosen in the console) with its own counts; society-wide totals stay as before.
  let gate = (await gates.currentPost(ctx))?.gate || null;
  if (!gate) {
    const open = await gates.listActive(s);
    if (open.length === 1) gate = open[0]; // one gate: that is where the guard is
  }
  const [pending, insideNow, helpInside, activeSos, gateCounts] = await Promise.all([
    Visitor.countDocuments({ society: s, status: 'pending' }),
    Visitor.countDocuments({ society: s, status: 'checked_in' }),
    DailyHelp.countDocuments({ society: s, isInside: true }),
    SosAlert.countDocuments({ society: s, status: { $ne: 'resolved' } }),
    gate
      ? Promise.all([
          Visitor.countDocuments({ society: s, status: 'pending', entryGate: gate._id }),
          Visitor.countDocuments({ society: s, status: 'checked_in', entryGate: gate._id }),
          Visitor.countDocuments({ society: s, entryGate: gate._id, createdAt: { $gte: startOfLocalDay() } }),
        ])
      : null,
  ]);
  return {
    pendingVisitors: pending,
    insideNow,
    helpInside,
    activeSos,
    gate: gate && { _id: gate._id, name: gate.name, code: gate.code },
    atGate: gateCounts && { pending: gateCounts[0], inside: gateCounts[1], today: gateCounts[2] },
  };
}

async function resident(ctx) {
  const s = ctx.societyId;
  const audience = await audienceFilter(ctx);
  const [dues, pendingVisitors, openComplaints, upcomingBookings, unreadNotices, openPolls, recentBills] = await Promise.all([
    billing.summary(ctx),
    Visitor.find({ society: s, unit: ctx.unitId, status: 'pending' }).sort({ createdAt: -1 }).lean(),
    Complaint.countDocuments({ society: s, raisedBy: ctx.userId, status: { $in: ACTIVE_COMPLAINT } }),
    Booking.find({ society: s, user: ctx.userId, date: { $gte: localToday() }, status: { $in: ['pending', 'confirmed'] } })
      .sort({ date: 1, startTime: 1 })
      .limit(3)
      .populate('amenity', 'name')
      .lean(),
    // $and keeps the audience $or intact; scheduled notices don't count until published
    Notice.countDocuments({ society: s, ...audience, readBy: { $ne: ctx.userId }, $and: [{ $or: [{ publishAt: null }, { publishAt: { $lte: new Date() } }] }] }),
    Poll.countDocuments({ society: s, ...audience, status: 'open', $and: [{ $or: [{ closesAt: null }, { closesAt: { $gt: new Date() } }] }] }),
    Bill.find({ society: s, unit: ctx.unitId, status: { $in: ['unpaid', 'partial'] } }).sort({ dueDate: 1 }).limit(3).lean(),
  ]);
  return {
    dues,
    pendingVisitors,
    openComplaints,
    upcomingBookings,
    unreadNotices,
    openPolls,
    unpaidBills: recentBills.map((b) => ({ ...b, balance: b.total - b.paid })),
  };
}

async function staff(ctx) {
  const [assigned, overdue] = await Promise.all([
    Complaint.countDocuments({ society: ctx.societyId, assignedTo: ctx.userId, status: { $in: ACTIVE_COMPLAINT } }),
    Complaint.countDocuments({ society: ctx.societyId, assignedTo: ctx.userId, status: { $in: ACTIVE_COMPLAINT }, slaDueAt: { $lt: new Date() } }),
  ]);
  return { assignedComplaints: assigned, overdueComplaints: overdue };
}

export async function forRole(ctx) {
  switch (ctx.role) {
    case ROLES.GUARD:
      return { view: 'guard', ...(await guard(ctx)) };
    case ROLES.RESIDENT:
      return { view: 'resident', ...(await resident(ctx)) };
    case ROLES.STAFF:
      return { view: 'staff', ...(await staff(ctx)) };
    default:
      return { view: 'management', ...(await management(ctx)) };
  }
}
