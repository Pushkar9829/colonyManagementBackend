import WorkOrder from './workOrder.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { ROLES } from '../../common/constants/index.js';
import { nextNumber } from '../counter/counter.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import * as assets from '../assets/assets.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import { assertMember, isManagerRole } from '../assets/facility.shared.js';
import { money } from '../../common/utils/money.js';
import { findBreakdown, findTask, linkWorkOrder } from './maintenance.service.js';

const MANAGERS = [ROLES.ADMIN, ROLES.FACILITY_MANAGER];
const POPULATE = [
  { path: 'asset', select: 'name code location' },
  { path: 'technician', select: 'name phone' },
  { path: 'breakdown', select: 'number title status' },
  { path: 'ppmTask', select: 'title dueDate' },
  { path: 'createdBy', select: 'name' },
  { path: 'history.by', select: 'name' },
];

const scope = (ctx) => (isManagerRole(ctx.role) ? { society: ctx.societyId } : { society: ctx.societyId, technician: ctx.userId });

async function load(ctx, id) {
  const wo = await WorkOrder.findOne({ ...scope(ctx), _id: id });
  if (!wo) throw ApiError.notFound('Work order not found');
  return wo;
}

const reload = (id) => WorkOrder.findById(id).populate(POPULATE).lean();

export async function create(ctx, { attachments: ids, ...data }) {
  // Links pull in the asset so the work shows up on its service history.
  if (data.breakdown) {
    const b = await findBreakdown(ctx, data.breakdown);
    if (!b) throw ApiError.badRequest('Breakdown not found');
    data.asset = data.asset || String(b.asset);
    data.source = 'breakdown';
  }
  if (data.ppmTask) {
    const task = await findTask(ctx, data.ppmTask);
    if (!task) throw ApiError.badRequest('PPM task not found');
    data.asset = data.asset || String(task.asset);
    if (!data.breakdown) data.source = 'ppm';
  }
  if (data.asset) {
    await assets.findForSociety(ctx, data.asset);
    if (data.source === 'adhoc') data.source = 'asset';
  }
  if (data.technician) await assertMember(ctx, data.technician, [ROLES.STAFF, ROLES.FACILITY_MANAGER], 'Technician');
  const attachments = await uploads.resolve(ctx, ids);
  const wo = await WorkOrder.create({
    ...data,
    attachments,
    society: ctx.societyId,
    number: await nextNumber(ctx.societyId, 'work_order', 'WO'),
    createdBy: ctx.userId,
    history: [{ by: ctx.userId, to: 'open' }],
  });
  if (data.breakdown) await linkWorkOrder(ctx, data.breakdown, wo._id);
  if (wo.asset) await assets.recordEvent(ctx, wo.asset, { type: 'work_order', title: `Work order ${wo.number} raised`, notes: `${wo.title}${wo.vendorName ? ` · ${wo.vendorName}` : ''}`, ref: { kind: 'WorkOrder', id: wo._id } });
  if (wo.technician) await notifyUsers(ctx.societyId, [wo.technician], { type: 'facility', title: `Work order ${wo.number} assigned to you`, body: wo.title, link: `/work-orders?id=${wo._id}` });
  audit.record(ctx, 'work_order.created', 'WorkOrder', wo._id, { number: wo.number, estimate: wo.estimate, vendorName: wo.vendorName });
  return reload(wo._id);
}

export function list(ctx, filters, pagination) {
  const filter = scope(ctx);
  if (filters.status) filter.status = filters.status;
  if (filters.open) filter.status = { $in: ['open', 'in_progress'] };
  if (filters.asset) filter.asset = filters.asset;
  if (filters.vendor) filter.vendor = filters.vendor;
  if (filters.mine) filter.technician = ctx.userId;
  return paginate(WorkOrder, filter, pagination, { populate: POPULATE.slice(0, 2), select: '-history' });
}

export async function getById(ctx, id) {
  await load(ctx, id);
  return reload(id);
}

export async function update(ctx, id, data) {
  const wo = await load(ctx, id);
  if (['verified', 'cancelled'].includes(wo.status)) throw ApiError.conflict(`Work order is ${wo.status}`);
  if (data.technician) await assertMember(ctx, data.technician, [ROLES.STAFF, ROLES.FACILITY_MANAGER], 'Technician');
  const newTech = data.technician && String(data.technician) !== String(wo.technician || '');
  for (const [k, v] of Object.entries(data)) wo.set(k, v === null ? undefined : v);
  await wo.save();
  if (newTech) await notifyUsers(ctx.societyId, [data.technician], { type: 'facility', title: `Work order ${wo.number} assigned to you`, body: wo.title, link: `/work-orders?id=${wo._id}` });
  audit.record(ctx, 'work_order.updated', 'WorkOrder', wo._id, { fields: Object.keys(data) });
  return reload(wo._id);
}

// open → in_progress → completed (proof) → verified by a manager; cancel any time before verification.
const FLOW = { open: ['in_progress', 'completed', 'cancelled'], in_progress: ['completed', 'cancelled'], completed: ['verified', 'in_progress'], verified: [], cancelled: [] };

export async function changeStatus(ctx, id, { status, note, actualCost, attachments: ids }) {
  const wo = await load(ctx, id);
  if (!FLOW[wo.status].includes(status)) throw ApiError.conflict(`Cannot move from ${wo.status} to ${status}`);
  const manager = isManagerRole(ctx.role);
  if (!manager && ['verified', 'cancelled'].includes(status)) throw ApiError.forbidden('Only managers can verify or cancel work orders');
  if (!manager && wo.status === 'completed') throw ApiError.forbidden('Only managers can reopen completed work');
  const attachments = await uploads.resolve(ctx, ids);
  if (status === 'completed') {
    if (!note && !attachments.length) throw ApiError.badRequest('Add completion notes or proof photos');
    wo.completion = { notes: note, attachments, completedAt: new Date(), completedBy: ctx.userId };
    if (actualCost !== undefined) wo.actualCost = actualCost;
  }
  if (status === 'verified') {
    if (actualCost !== undefined) wo.actualCost = actualCost;
    wo.set({ verifiedBy: ctx.userId, verifiedAt: new Date() });
  }
  wo.history.push({ by: ctx.userId, from: wo.status, to: status, note });
  wo.status = status;
  await wo.save();

  if (status === 'completed') {
    await notifyRoles(ctx.societyId, MANAGERS, { type: 'facility', title: `Work order ${wo.number} completed`, body: note || wo.title, link: `/work-orders?id=${wo._id}` });
  }
  if (status === 'verified' && wo.asset) {
    const cost = wo.actualCost ?? wo.estimate;
    await assets.recordEvent(ctx, wo.asset, {
      type: 'service',
      title: `Work order ${wo.number} done: ${wo.title}`,
      notes: [wo.vendorName, wo.completion?.notes, cost ? money(cost) : null].filter(Boolean).join(' · '),
      cost: cost || undefined,
      attachments: wo.completion?.attachments || [],
      ref: { kind: 'WorkOrder', id: wo._id },
    });
  }
  if (['verified', 'cancelled'].includes(status)) audit.record(ctx, `work_order.${status}`, 'WorkOrder', wo._id, { number: wo.number, actualCost: wo.actualCost });
  return reload(wo._id);
}

export async function stats(ctx) {
  const rows = await WorkOrder.aggregate([
    { $match: { society: ctx.societyId } },
    { $group: { _id: '$status', count: { $sum: 1 }, estimate: { $sum: '$estimate' }, actual: { $sum: { $ifNull: ['$actualCost', 0] } } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r]));
  return {
    open: (by.open?.count || 0) + (by.in_progress?.count || 0),
    awaitingVerification: by.completed?.count || 0,
    verified: by.verified?.count || 0,
    openEstimate: (by.open?.estimate || 0) + (by.in_progress?.estimate || 0),
    spent: by.verified?.actual || 0,
  };
}
