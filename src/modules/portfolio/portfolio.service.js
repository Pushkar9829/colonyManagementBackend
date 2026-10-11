import mongoose from 'mongoose';
import Membership from '../users/membership.model.js';
import Society from '../society/society.model.js';
import Unit from '../units/unit.model.js';
import Bill from '../billing/bill.model.js';
import Payment from '../payments/payment.model.js';
import Complaint from '../complaints/complaint.model.js';
import SosAlert from '../sos/sos.model.js';
import Visitor from '../visitors/visitor.model.js';
import DailyHelp from '../dailyHelp/dailyHelp.model.js';
import { ROLES } from '../../common/constants/index.js';
import { localDateString, localPeriod, startOfLocalDay } from '../../common/utils/dates.js';

const MANAGER_ROLES = [ROLES.ADMIN, ROLES.FACILITY_MANAGER];
const ACTIVE_COMPLAINT = ['open', 'assigned', 'in_progress', 'on_hold', 'reopened'];

// Group-by-society aggregate -> Map(societyId -> value)
async function bySociety(model, match, group) {
  const rows = await model.aggregate([{ $match: match }, { $group: { _id: '$society', ...group } }]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

// Staff attendance is a separate (optional) module; count today's check-ins only when its model is loaded.
async function staffPresent(ids, today) {
  const model = mongoose.models.StaffAttendance;
  if (!model) return null;
  const paths = model.schema.paths;
  const match = { society: { $in: ids } };
  if (paths.date) match.date = localDateString(today);
  else if (paths.inAt) match.inAt = { $gte: today };
  else if (paths.checkInAt) match.checkInAt = { $gte: today };
  else return null;
  if (paths.outAt) match.outAt = null;
  else if (paths.checkOutAt) match.checkOutAt = null;
  return bySociety(model, match, { n: { $sum: 1 } });
}

// Cross-society dashboard for a person who manages several societies (e.g. a facility-management
// company). Reads only societies where the caller holds an active admin / facility-manager membership.
export async function overview(userId, currentMembershipId) {
  const memberships = await Membership.find({ user: userId, role: { $in: MANAGER_ROLES }, status: 'active' }).sort({ createdAt: 1 }).lean();
  const societyIds = [...new Set(memberships.map((m) => String(m.society)))].map((id) => new mongoose.Types.ObjectId(id));
  const societies = await Society.find({ _id: { $in: societyIds } }).select('name code city active plan').lean();
  const active = societies.filter((s) => s.active).map((s) => s._id);

  const now = new Date();
  const today = startOfLocalDay(now);
  const period = localPeriod(now);
  const monthStart = new Date(`${period}-01T00:00:00+05:30`);
  const inSoc = { society: { $in: active } };

  const [units, billed, collected, overdue, complaints, breaches, sos, visitors, helpInside, staff] = await Promise.all([
    bySociety(Unit, inSoc, { n: { $sum: 1 } }),
    bySociety(Bill, { ...inSoc, period, status: { $ne: 'cancelled' } }, { total: { $sum: '$total' } }),
    bySociety(Payment, { ...inSoc, status: 'success', paidAt: { $gte: monthStart } }, { total: { $sum: '$amount' } }),
    bySociety(Bill, { ...inSoc, status: { $in: ['unpaid', 'partial'] }, dueDate: { $lt: now } }, { total: { $sum: { $subtract: ['$total', '$paid'] } }, n: { $sum: 1 } }),
    bySociety(Complaint, { ...inSoc, status: { $in: ACTIVE_COMPLAINT } }, { n: { $sum: 1 } }),
    bySociety(Complaint, { ...inSoc, status: { $in: ACTIVE_COMPLAINT }, slaDueAt: { $lt: now } }, { n: { $sum: 1 } }),
    bySociety(SosAlert, { ...inSoc, status: { $ne: 'resolved' } }, { n: { $sum: 1 } }),
    bySociety(Visitor, { ...inSoc, createdAt: { $gte: today } }, { n: { $sum: 1 } }),
    bySociety(DailyHelp, { ...inSoc, isInside: true }, { n: { $sum: 1 } }),
    staffPresent(active, today),
  ]);

  const v = (map, id, key = 'n') => map?.get(String(id))?.[key] || 0;
  const rows = societies.map((s) => {
    const own = memberships.filter((m) => String(m.society) === String(s._id));
    const preferred = own.find((m) => String(m._id) === String(currentMembershipId)) || own.find((m) => m.role === ROLES.ADMIN) || own[0];
    const b = v(billed, s._id, 'total');
    const c = v(collected, s._id, 'total');
    return {
      society: { _id: s._id, name: s.name, code: s.code, city: s.city, active: s.active, plan: s.plan?.name || 'free' },
      membershipId: preferred._id,
      role: preferred.role,
      current: own.some((m) => String(m._id) === String(currentMembershipId)),
      units: v(units, s._id),
      billedThisMonth: b,
      collectedThisMonth: c,
      collectionRate: b ? Math.round((c / b) * 100) : null,
      overdueAmount: v(overdue, s._id, 'total'),
      overdueBills: v(overdue, s._id),
      openComplaints: v(complaints, s._id),
      slaBreaches: v(breaches, s._id),
      activeSos: v(sos, s._id),
      visitorsToday: v(visitors, s._id),
      helpInside: v(helpInside, s._id),
      staffPresent: staff ? v(staff, s._id) : null,
    };
  });
  rows.sort((a, b) => b.activeSos - a.activeSos || b.slaBreaches - a.slaBreaches || a.society.name.localeCompare(b.society.name));

  const sum = (key) => rows.reduce((t, r) => t + (r[key] || 0), 0);
  const totals = {
    societies: rows.length,
    units: sum('units'),
    billedThisMonth: sum('billedThisMonth'),
    collectedThisMonth: sum('collectedThisMonth'),
    overdueAmount: sum('overdueAmount'),
    overdueBills: sum('overdueBills'),
    openComplaints: sum('openComplaints'),
    slaBreaches: sum('slaBreaches'),
    activeSos: sum('activeSos'),
    visitorsToday: sum('visitorsToday'),
    helpInside: sum('helpInside'),
    staffPresent: staff ? sum('staffPresent') : null,
  };
  totals.collectionRate = totals.billedThisMonth ? Math.round((totals.collectedThisMonth / totals.billedThisMonth) * 100) : null;
  return { period, totals, societies: rows, attendanceTracked: Boolean(staff) };
}
