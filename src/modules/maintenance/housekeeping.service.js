import Checklist from './checklist.model.js';
import ChecklistRun from './checklistRun.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { ROLES } from '../../common/constants/index.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import { addDaysStr, assertMember, assignedFilter, canWorkOn, istInstant, isManagerRole, today, weekday } from '../assets/facility.shared.js';

const MANAGERS = [ROLES.ADMIN, ROLES.FACILITY_MANAGER];
const RUN_POPULATE = [
  { path: 'assignee', select: 'name' },
  { path: 'completedBy', select: 'name' },
  { path: 'verifiedBy', select: 'name' },
];

// ---- templates ----
export async function createChecklist(ctx, data) {
  await assertMember(ctx, data.assignee);
  const doc = await Checklist.create({ ...data, society: ctx.societyId });
  await generateRuns(doc);
  audit.record(ctx, 'checklist.created', 'Checklist', doc._id, { name: doc.name });
  return doc.toObject();
}

export const listChecklists = (ctx) => Checklist.find({ society: ctx.societyId }).sort({ active: -1, name: 1 }).populate({ path: 'assignee', select: 'name' }).lean();

export async function updateChecklist(ctx, id, data) {
  const doc = await Checklist.findOne({ _id: id, society: ctx.societyId });
  if (!doc) throw ApiError.notFound('Checklist not found');
  if (data.assignee) await assertMember(ctx, data.assignee);
  for (const [k, v] of Object.entries(data)) doc.set(k, v === null ? undefined : v);
  await doc.save();
  // Today's untouched runs follow the new template.
  await ChecklistRun.deleteMany({ checklist: doc._id, status: 'pending', date: { $gte: today() }, completedAt: null });
  await generateRuns(doc);
  return doc.toObject();
}

// ---- run generation (today and tomorrow, so the night shift sees the next morning's work) ----
export async function generateRuns(checklist, now = new Date()) {
  if (!checklist.active) return 0;
  const t = today(now);
  const ops = [];
  for (const date of [t, addDaysStr(t, 1)]) {
    if (!checklist.days.includes(weekday(date))) continue;
    for (const slot of checklist.slots) {
      const dueAt = istInstant(date, slot.dueBy);
      ops.push({
        updateOne: {
          filter: { checklist: checklist._id, date, slot: slot.label },
          update: {
            $setOnInsert: {
              society: checklist.society,
              checklist: checklist._id,
              name: checklist.name,
              area: checklist.area,
              date,
              slot: slot.label,
              dueAt,
              missAt: new Date(dueAt.getTime() + (checklist.graceMinutes ?? 120) * 60000),
              assigneeRole: checklist.assigneeRole,
              assignee: checklist.assignee || undefined,
              items: checklist.items.map((i) => ({ itemId: i._id, label: i.label, done: false })),
            },
          },
          upsert: true,
        },
      });
    }
  }
  if (!ops.length) return 0;
  const res = await ChecklistRun.bulkWrite(ops, { ordered: false });
  return res.upsertedCount;
}

export async function generateAllRuns(now = new Date()) {
  const societies = (await Society.find({ active: true }).select('_id').lean()).map((s) => s._id);
  const lists = await Checklist.find({ society: { $in: societies }, active: true });
  let created = 0;
  // eslint-disable-next-line no-await-in-loop
  for (const c of lists) created += await generateRuns(c, now);
  return { checklists: lists.length, created };
}

// Pending runs past their grace window → missed; managers get one summary per society.
export async function sweepMissed(now = new Date()) {
  const missed = await ChecklistRun.find({ status: 'pending', missAt: { $lt: now } }).select('society name slot date').limit(5000).lean();
  if (!missed.length) return { missed: 0 };
  await ChecklistRun.updateMany({ _id: { $in: missed.map((r) => r._id) } }, { status: 'missed' });
  const bySociety = new Map();
  for (const r of missed) bySociety.set(String(r.society), [...(bySociety.get(String(r.society)) || []), r]);
  for (const [society, runs] of bySociety) {
    // eslint-disable-next-line no-await-in-loop
    await notifyRoles(society, MANAGERS, {
      type: 'facility',
      title: `${runs.length} checklist(s) missed`,
      body: runs.slice(0, 3).map((r) => `${r.name} (${r.slot})`).join(', '),
      link: '/checklists?status=missed',
    });
  }
  return { missed: missed.length };
}

// ---- runs ----
export function listRuns(ctx, filters, pagination) {
  const filter = { society: ctx.societyId, ...assignedFilter(ctx) };
  if (filters.mine && isManagerRole(ctx.role)) filter.assignee = ctx.userId;
  if (filters.date) filter.date = filters.date;
  if (filters.from || filters.to) filter.date = { ...(filters.from && { $gte: filters.from }), ...(filters.to && { $lte: filters.to }) };
  if (filters.status) filter.status = filters.status;
  if (filters.checklist) filter.checklist = filters.checklist;
  return paginate(ChecklistRun, filter, pagination, { sort: { dueAt: 1 }, populate: RUN_POPULATE });
}

async function loadRun(ctx, id) {
  const run = await ChecklistRun.findOne({ _id: id, society: ctx.societyId });
  if (!run || !canWorkOn(ctx, run)) throw ApiError.notFound('Checklist not found');
  return run;
}

export async function completeRun(ctx, id, { items, photos: photoIds, remarks }) {
  const run = await loadRun(ctx, id);
  if (!['pending', 'rejected'].includes(run.status)) throw ApiError.conflict(`This checklist is ${run.status}`);
  if (run.date > today()) throw ApiError.conflict('This checklist is for a later day');
  const template = await Checklist.findById(run.checklist).select('requirePhoto').lean();
  const photos = await uploads.resolve(ctx, photoIds);
  if (template?.requirePhoto && !photos.length) throw ApiError.badRequest('Add at least one photo as proof');
  const answers = new Map(items.map((i) => [String(i.itemId), i]));
  run.items = run.items.map((i) => {
    const a = answers.get(String(i.itemId));
    return { itemId: i.itemId, label: i.label, done: Boolean(a?.done), note: a?.note };
  });
  run.set({ photos, remarks, status: 'completed', completedBy: ctx.userId, completedAt: new Date(), verifiedBy: undefined, verifiedAt: undefined });
  await run.save();
  invalidate(ctx.societyId, ['checklists']);
  return ChecklistRun.findById(run._id).populate(RUN_POPULATE).lean();
}

// Supervisor check of completed work. Rejecting sends it back to the assignee to redo.
export async function verifyRun(ctx, id, { approved, note }) {
  const run = await loadRun(ctx, id);
  if (run.status !== 'completed') throw ApiError.conflict('Only completed checklists can be verified');
  run.set({ status: approved ? 'verified' : 'rejected', verifiedBy: ctx.userId, verifiedAt: new Date(), verifyNote: note });
  await run.save();
  if (!approved && run.completedBy) {
    await notifyUsers(ctx.societyId, [run.completedBy], { type: 'facility', title: `Redo: ${run.name} (${run.slot})`, body: note || 'The supervisor sent this checklist back', link: '/my-work' });
  }
  return ChecklistRun.findById(run._id).populate(RUN_POPULATE).lean();
}

// Completion and missed counts per checklist for a date range (default last 7 days).
export async function runReport(ctx, { from, to }) {
  const end = to || today();
  const start = from || addDaysStr(end, -6);
  const rows = await ChecklistRun.aggregate([
    { $match: { society: ctx.societyId, date: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: '$checklist',
        name: { $first: '$name' },
        area: { $first: '$area' },
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $in: ['$status', ['completed', 'verified']] }, 1, 0] } },
        verified: { $sum: { $cond: [{ $eq: ['$status', 'verified'] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
        missed: { $sum: { $cond: [{ $eq: ['$status', 'missed'] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
        missedSlots: { $push: { $cond: [{ $eq: ['$status', 'missed'] }, { date: '$date', slot: '$slot' }, '$$REMOVE'] } },
      },
    },
    { $sort: { name: 1 } },
  ]);
  return {
    from: start,
    to: end,
    rows: rows.map((r) => {
      const counted = r.total - r.pending;
      return { ...r, checklist: r._id, _id: undefined, completionRate: counted ? Math.round((r.completed / counted) * 1000) / 10 : null };
    }),
  };
}
