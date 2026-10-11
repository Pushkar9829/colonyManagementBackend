import FireExtinguisher from './fireExtinguisher.model.js';
import FireDrill from './fireDrill.model.js';
import FireNoc from './fireNoc.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { nextNumber } from '../counter/counter.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { addDaysStr, diffDays, today } from './facility.shared.js';

function dueState(dateStr, t) {
  if (!dateStr) return 'none';
  if (dateStr < t) return 'overdue';
  return diffDays(t, dateStr) <= 30 ? 'due_soon' : 'ok';
}

function presentExtinguisher(e, t = today()) {
  const { alertsSent, ...rest } = e;
  const refill = dueState(e.nextRefillDue, t);
  const expiry = dueState(e.expiryDate, t);
  const rank = { overdue: 3, due_soon: 2, ok: 1, none: 0 };
  return { ...rest, refillState: refill, expiryState: expiry, state: rank[refill] >= rank[expiry] ? refill : expiry };
}

export async function listExtinguishers(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.active !== undefined) filter.active = filters.active;
  if (filters.dueWithin !== undefined) {
    const until = addDaysStr(today(), filters.dueWithin);
    filter.$or = [{ nextRefillDue: { $lte: until } }, { expiryDate: { $lte: until } }];
  }
  const result = await paginate(FireExtinguisher, filter, pagination, { sort: { code: 1 }, populate: { path: 'block', select: 'name' } });
  const t = today();
  result.items = result.items.map((e) => presentExtinguisher(e, t));
  return result;
}

export async function createExtinguisher(ctx, data) {
  const doc = await FireExtinguisher.create({ ...data, society: ctx.societyId, code: await nextNumber(ctx.societyId, 'fire_extinguisher', 'FE', 4) });
  audit.record(ctx, 'fire.extinguisher_added', 'FireExtinguisher', doc._id, { code: doc.code, location: doc.location });
  return presentExtinguisher(doc.toObject());
}

export async function updateExtinguisher(ctx, id, data) {
  const doc = await FireExtinguisher.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: data }, { returnDocument: 'after', runValidators: true }).lean();
  if (!doc) throw ApiError.notFound('Extinguisher not found');
  return presentExtinguisher(doc);
}

// Refilling resets the reminders for the new due date.
export async function refillExtinguisher(ctx, id, data) {
  if (data.nextRefillDue <= data.lastRefillDate) throw ApiError.badRequest('Next refill must be after the refill date');
  const doc = await FireExtinguisher.findOneAndUpdate(
    { _id: id, society: ctx.societyId },
    { $set: { ...data, lastInspectedOn: data.lastRefillDate, alertsSent: [] } },
    { returnDocument: 'after' },
  ).lean();
  if (!doc) throw ApiError.notFound('Extinguisher not found');
  audit.record(ctx, 'fire.extinguisher_refilled', 'FireExtinguisher', id, data);
  return presentExtinguisher(doc);
}

export const listDrills = (ctx, pagination) => paginate(FireDrill, { society: ctx.societyId }, pagination, { sort: { date: -1 }, populate: { path: 'by', select: 'name' } });

export async function createDrill(ctx, { attachments: ids, ...data }) {
  const attachments = await uploads.resolve(ctx, ids);
  const drill = await FireDrill.create({ ...data, attachments, society: ctx.societyId, by: ctx.userId });
  audit.record(ctx, 'fire.drill_logged', 'FireDrill', drill._id, { date: data.date, attendance: data.attendance });
  return drill.toObject();
}

export async function listNocs(ctx) {
  const t = today();
  const items = await FireNoc.find({ society: ctx.societyId }).sort({ expiryDate: -1 }).select('-alertsSent').lean();
  return items.map((n, i) => ({ ...n, current: i === 0, state: dueState(n.expiryDate, t), daysLeft: diffDays(t, n.expiryDate) }));
}

export async function createNoc(ctx, { documents: ids, ...data }) {
  const documents = await uploads.resolve(ctx, ids);
  const noc = await FireNoc.create({ ...data, documents, society: ctx.societyId, by: ctx.userId });
  audit.record(ctx, 'fire.noc_added', 'FireNoc', noc._id, { number: data.number, expiryDate: data.expiryDate });
  return noc.toObject();
}

export async function summary(ctx) {
  const t = today();
  const in30 = addDaysStr(t, 30);
  const [total, refillDue, overdue, lastDrill, noc] = await Promise.all([
    FireExtinguisher.countDocuments({ society: ctx.societyId, active: true }),
    FireExtinguisher.countDocuments({ society: ctx.societyId, active: true, $or: [{ nextRefillDue: { $gte: t, $lte: in30 } }, { expiryDate: { $gte: t, $lte: in30 } }] }),
    FireExtinguisher.countDocuments({ society: ctx.societyId, active: true, $or: [{ nextRefillDue: { $lt: t } }, { expiryDate: { $lt: t } }] }),
    FireDrill.findOne({ society: ctx.societyId }).sort({ date: -1 }).select('date attendance').lean(),
    FireNoc.findOne({ society: ctx.societyId }).sort({ expiryDate: -1 }).select('number expiryDate').lean(),
  ]);
  return {
    extinguishers: total,
    refillDue,
    overdue,
    lastDrill,
    noc: noc ? { ...noc, state: dueState(noc.expiryDate, t), daysLeft: diffDays(t, noc.expiryDate) } : null,
  };
}
