import Society from '../society/society.model.js';
import Unit from '../units/unit.model.js';
import Bill from '../billing/bill.model.js';
import Payment from '../payments/payment.model.js';
import Complaint from '../complaints/complaint.model.js';
import Visitor from '../visitors/visitor.model.js';
import SosAlert from '../sos/sos.model.js';
import Booking from '../amenities/booking.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { localPeriod } from '../../common/utils/dates.js';
import { suggest } from './complaintCategories.js';
import { riskForUnit, riskList } from './defaulterRisk.js';
import { NOTICE_TEMPLATES, render, templateByKey } from './noticeTemplates.js';

const ACTIVE_COMPLAINT = ['open', 'assigned', 'in_progress', 'on_hold', 'reopened'];

export const suggestCategory = (ctx, body) => suggest(ctx.societyId, body);
export const defaulterRisk = (ctx, filters) => riskList(ctx.societyId, filters);

export async function unitRisk(ctx, unitId) {
  const r = await riskForUnit(ctx.societyId, unitId);
  if (!r) throw ApiError.notFound('Unit not found');
  return r;
}

export const listTemplates = () => NOTICE_TEMPLATES.map(({ key, label, category, fields }) => ({ key, label, category, fields }));

export async function renderTemplate(ctx, key, values) {
  const template = templateByKey(key);
  if (!template) throw ApiError.notFound('Unknown template');
  const society = await Society.findById(ctx.societyId).select('name').lean();
  return render(template, values, society?.name || 'the society');
}

// ---------- monthly society health ----------
const shift = (period, months) => {
  const [y, m] = period.split('-').map(Number);
  const t = y * 12 + (m - 1) + months;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const bounds = (period) => ({ from: new Date(`${period}-01T00:00:00+05:30`), to: new Date(`${shift(period, 1)}-01T00:00:00+05:30`) });
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

async function metrics(s, period) {
  const { from, to } = bounds(period);
  const end = to < new Date() ? to : new Date();
  const [units, billAgg, collectedAgg, opened, resolvedList, openNow, breachedNow, visitors, sos, bookings, newMembers] = await Promise.all([
    Unit.countDocuments({ society: s }),
    Bill.aggregate([{ $match: { society: s, period, status: { $ne: 'cancelled' } } }, { $group: { _id: null, billed: { $sum: '$total' }, paid: { $sum: '$paid' }, n: { $sum: 1 } } }]),
    Payment.aggregate([{ $match: { society: s, status: 'success', paidAt: { $gte: from, $lt: to } } }, { $group: { _id: null, sum: { $sum: '$amount' } } }]),
    Complaint.countDocuments({ society: s, createdAt: { $gte: from, $lt: to } }),
    Complaint.find({ society: s, resolvedAt: { $gte: from, $lt: to } }).select('createdAt resolvedAt slaDueAt').lean(),
    Complaint.countDocuments({ society: s, status: { $in: ACTIVE_COMPLAINT }, createdAt: { $lt: end } }),
    Complaint.countDocuments({ society: s, status: { $in: ACTIVE_COMPLAINT }, slaDueAt: { $lt: end } }),
    Visitor.countDocuments({ society: s, createdAt: { $gte: from, $lt: to } }),
    SosAlert.find({ society: s, createdAt: { $gte: from, $lt: to } }).select('createdAt acknowledgedAt').lean(),
    Booking.countDocuments({ society: s, date: { $gte: `${period}-01`, $lt: `${shift(period, 1)}-01` }, status: 'confirmed' }),
    Membership.countDocuments({ society: s, status: 'active', createdAt: { $gte: from, $lt: to } }),
  ]);
  const b = billAgg[0] || { billed: 0, paid: 0, n: 0 };
  const resolved = resolvedList.length;
  const slaMet = resolvedList.filter((c) => c.slaDueAt && c.resolvedAt <= c.slaDueAt).length;
  const avgResolutionHours = resolved ? Math.round(resolvedList.reduce((t, c) => t + (c.resolvedAt - c.createdAt) / 3600000, 0) / resolved) : null;
  const acked = sos.filter((a) => a.acknowledgedAt);
  const avgSosAckMinutes = acked.length ? Math.round(acked.reduce((t, a) => t + (a.acknowledgedAt - a.createdAt) / 60000, 0) / acked.length) : null;
  return {
    units,
    billing: { bills: b.n, billed: b.billed, collectedAgainstBills: b.paid, collectionRate: pct(b.paid, b.billed), collectedInMonth: collectedAgg[0]?.sum || 0 },
    complaints: { opened, resolved, slaMetRate: pct(slaMet, resolved), avgResolutionHours, openNow, breachedNow },
    visitors,
    sos: { raised: sos.length, avgAckMinutes: avgSosAckMinutes },
    bookings,
    newMembers,
  };
}

// Score out of 100: collection rate 40%, SLA met 30%, complaint backlog 30% (open complaints per 100 units;
// 10+ per 100 units scores zero). Missing data counts as neutral (half marks) rather than perfect.
function healthScore(m) {
  const collection = m.billing.collectionRate ?? 50;
  const sla = m.complaints.slaMetRate ?? 50;
  const per100 = m.units ? (m.complaints.openNow / m.units) * 100 : 0;
  const backlog = Math.max(0, 100 - per100 * 10);
  const score = Math.round(collection * 0.4 + sla * 0.3 + backlog * 0.3);
  return { score, grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D', parts: { collection, sla, backlog: Math.round(backlog) } };
}

function highlights(m, prev) {
  const out = [];
  const rate = m.billing.collectionRate;
  if (rate !== null) out.push({ tone: rate >= 90 ? 'good' : rate >= 70 ? 'neutral' : 'bad', text: `${rate}% of this month’s maintenance has been collected.` });
  if (prev.billing.collectionRate !== null && rate !== null && rate !== prev.billing.collectionRate) {
    out.push({ tone: rate > prev.billing.collectionRate ? 'good' : 'bad', text: `Collection is ${rate > prev.billing.collectionRate ? 'up' : 'down'} ${Math.abs(rate - prev.billing.collectionRate)} points from last month.` });
  }
  if (m.complaints.breachedNow) out.push({ tone: 'bad', text: `${m.complaints.breachedNow} open complaint(s) are past their SLA.` });
  if (m.complaints.slaMetRate !== null) out.push({ tone: m.complaints.slaMetRate >= 80 ? 'good' : 'neutral', text: `${m.complaints.slaMetRate}% of complaints resolved this month met their SLA.` });
  if (m.complaints.opened > prev.complaints.opened * 1.5 && m.complaints.opened >= 5) out.push({ tone: 'bad', text: `Complaints rose to ${m.complaints.opened} from ${prev.complaints.opened} last month.` });
  if (m.sos.raised) out.push({ tone: 'neutral', text: `${m.sos.raised} SOS alert(s)${m.sos.avgAckMinutes !== null ? `, acknowledged in ${m.sos.avgAckMinutes} min on average` : ''}.` });
  if (m.newMembers) out.push({ tone: 'good', text: `${m.newMembers} new member(s) joined.` });
  return out;
}

export async function health(ctx, period = localPeriod()) {
  const [current, previous] = await Promise.all([metrics(ctx.societyId, period), metrics(ctx.societyId, shift(period, -1))]);
  return {
    period,
    previousPeriod: shift(period, -1),
    ...healthScore(current),
    previousScore: healthScore(previous).score,
    metrics: current,
    previous,
    highlights: highlights(current, previous),
    method: 'heuristic',
    note: 'A weighted checklist (collections 40%, SLA 30%, complaint backlog 30%), not a statistical model.',
  };
}
