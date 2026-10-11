import Bill from '../billing/bill.model.js';
import Payment from '../payments/payment.model.js';
import Unit from '../units/unit.model.js';
import Membership from '../users/membership.model.js';
import { ROLES } from '../../common/constants/index.js';
import { localPeriod } from '../../common/utils/dates.js';

// Defaulter risk — a transparent points HEURISTIC over the last 12 months of bills, not a prediction model.
//   up to 40 pts  late-payment ratio   (bills paid after the due date, or still unpaid past it)
//   up to 25 pts  average days late    (30+ days late on average = full points)
//   up to 25 pts  overdue bills now    (3+ overdue bills = full points)
//   up to 10 pts  overdue amount       (3+ months of the unit's average bill = full points)
// 60+ = high, 30-59 = medium, below 30 = low.
const DAY = 86400000;
const WINDOW_MONTHS = 12;

function windowStart(now) {
  const [y, m] = localPeriod(now).split('-').map(Number);
  const total = y * 12 + (m - 1) - (WINDOW_MONTHS - 1);
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export const band = (s) => (s >= 60 ? 'high' : s >= 30 ? 'medium' : 'low');

export function scoreUnit(bills, lastPaidByBill, now = new Date()) {
  const due = bills.filter((b) => b.dueDate < now);
  let late = 0;
  let daysLateSum = 0;
  let overdueBills = 0;
  let overdueAmount = 0;
  const detail = [];
  for (const b of due) {
    const balance = Math.max(0, b.total - b.paid);
    const settled = balance === 0;
    const paidAt = lastPaidByBill.get(String(b._id));
    let daysLate = 0;
    if (settled) daysLate = paidAt && paidAt > b.dueDate ? Math.ceil((paidAt - b.dueDate) / DAY) : 0;
    else {
      daysLate = Math.ceil((now - b.dueDate) / DAY);
      overdueBills += 1;
      overdueAmount += balance;
    }
    if (daysLate > 0) late += 1;
    daysLateSum += daysLate;
    detail.push({ billNumber: b.billNumber, period: b.period, total: b.total, balance, dueDate: b.dueDate, paidAt: paidAt || null, daysLate });
  }
  const n = due.length;
  const avgBill = n ? due.reduce((s, b) => s + b.total, 0) / n : 0;
  const lateRatio = n ? late / n : 0;
  const avgDaysLate = n ? daysLateSum / n : 0;
  const factors = [
    { key: 'lateRatio', label: 'Late payments', value: `${late} of ${n} bills`, points: Math.round(40 * lateRatio), max: 40, explanation: 'Share of due bills paid after the due date or still unpaid.' },
    { key: 'avgDaysLate', label: 'Average days late', value: `${Math.round(avgDaysLate)} days`, points: Math.round(25 * Math.min(avgDaysLate / 30, 1)), max: 25, explanation: 'Average delay across due bills; 30+ days gives full points.' },
    { key: 'overdueBills', label: 'Overdue bills now', value: `${overdueBills}`, points: Math.round(25 * Math.min(overdueBills / 3, 1)), max: 25, explanation: 'Bills past their due date with a balance; 3+ gives full points.' },
    { key: 'overdueAmount', label: 'Overdue amount', value: overdueAmount, points: avgBill ? Math.round(10 * Math.min(overdueAmount / (avgBill * 3), 1)) : 0, max: 10, explanation: 'Overdue balance compared with three average bills.' },
  ];
  const score = factors.reduce((s, f) => s + f.points, 0);
  return { score, band: band(score), billsConsidered: n, overdueBills, overdueAmount, lateRatio: Math.round(lateRatio * 100) / 100, avgDaysLate: Math.round(avgDaysLate * 10) / 10, factors, bills: detail };
}

async function data(societyId, unitFilter, now) {
  const bills = await Bill.find({ society: societyId, status: { $ne: 'cancelled' }, period: { $gte: windowStart(now) }, ...unitFilter })
    .select('unit billNumber period total paid dueDate status')
    .lean();
  const payments = await Payment.aggregate([
    { $match: { society: societyId, status: 'success', bill: { $in: bills.map((b) => b._id) } } },
    { $group: { _id: '$bill', last: { $max: '$paidAt' } } },
  ]);
  return { bills, lastPaid: new Map(payments.map((p) => [String(p._id), p.last])) };
}

export async function riskList(societyId, { band: wanted, limit = 50 } = {}, now = new Date()) {
  const { bills, lastPaid } = await data(societyId, {}, now);
  const byUnit = new Map();
  for (const b of bills) byUnit.set(String(b.unit), [...(byUnit.get(String(b.unit)) || []), b]);
  const units = await Unit.find({ society: societyId, _id: { $in: [...byUnit.keys()] } }).select('label').lean();
  const label = new Map(units.map((u) => [String(u._id), u.label]));
  let rows = [...byUnit.entries()].map(([unit, list]) => {
    const { bills: _detail, ...r } = scoreUnit(list, lastPaid, now);
    return { unit: { _id: unit, label: label.get(unit) }, ...r };
  });
  const counts = { high: 0, medium: 0, low: 0 };
  for (const r of rows) counts[r.band] += 1;
  if (wanted) rows = rows.filter((r) => r.band === wanted);
  rows.sort((a, b) => b.score - a.score || b.overdueAmount - a.overdueAmount);
  return {
    items: rows.slice(0, limit),
    counts,
    windowMonths: WINDOW_MONTHS,
    method: 'heuristic',
    note: 'Points from payment history (late ratio, average days late, current overdue). A prompt for a friendly follow-up, not a credit score.',
  };
}

export async function riskForUnit(societyId, unitId, now = new Date()) {
  const unit = await Unit.findOne({ _id: unitId, society: societyId }).select('label').lean();
  if (!unit) return null;
  const { bills, lastPaid } = await data(societyId, { unit: unit._id }, now);
  const residents = await Membership.find({ society: societyId, unit: unit._id, role: ROLES.RESIDENT, status: 'active' }).populate('user', 'name phone').lean();
  return { unit, residents: residents.map((m) => ({ name: m.user?.name, phone: m.user?.phone, residentType: m.residentType })), ...scoreUnit(bills, lastPaid, now), windowMonths: WINDOW_MONTHS, method: 'heuristic' };
}
