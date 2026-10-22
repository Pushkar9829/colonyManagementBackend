// Purchase requests with maker-checker approval: whoever raises a request can never approve it.
import PurchaseRequest from './purchaseRequest.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { ROLES } from '../../common/constants/index.js';
import { money } from '../../common/utils/money.js';
import { nextNumber } from '../counter/counter.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import { getSettings, isFinance, loadVendor, refresh } from './vendors.service.js';

const POPULATE = [
  { path: 'vendor', select: 'name category phone' },
  { path: 'requestedBy', select: 'name' },
  { path: 'decidedBy', select: 'name' },
  { path: 'vendorBill', select: 'number billNo status' },
  { path: 'history.by', select: 'name' },
];
const link = (pr) => `/expenses/purchase-requests?open=${pr._id}`;
const sameUser = (a, b) => String(a) === String(b);

// Facility managers see their own requests; the finance team sees all.
function scope(ctx) {
  const filter = { society: ctx.societyId };
  if (!isFinance(ctx)) filter.requestedBy = ctx.userId;
  return filter;
}

async function load(ctx, id) {
  const pr = await PurchaseRequest.findOne({ ...scope(ctx), _id: id });
  if (!pr) throw ApiError.notFound('Purchase request not found');
  return pr;
}

const reload = (id) => PurchaseRequest.findById(id).populate(POPULATE).lean();

function normaliseItems(items = []) {
  return items.map((i) => {
    const quantity = i.quantity ?? 1;
    const amount = i.amount ?? Math.round(quantity * (i.rate || 0));
    return { description: i.description, quantity, rate: i.rate ?? (quantity ? Math.round(amount / quantity) : 0), amount };
  });
}

function totals(data) {
  const items = normaliseItems(data.items);
  const amount = items.length ? items.reduce((s, i) => s + i.amount, 0) : data.amount;
  if (!(amount > 0)) throw ApiError.badRequest('Enter the items or an estimated amount');
  return { items, amount };
}

function transition(pr, by, to, note) {
  pr.history.push({ by, from: pr.status, to, note });
  pr.status = to;
}

export async function list(ctx, filters, pagination) {
  const filter = scope(ctx);
  if (filters.status) filter.status = filters.status;
  if (filters.vendor) filter.vendor = filters.vendor;
  if (filters.mine) filter.requestedBy = ctx.userId;
  if (filters.awaitingMe) {
    // pending requests this admin may decide on (not their own)
    filter.status = 'pending';
    filter.requestedBy = { $ne: ctx.userId };
  }
  if (filters.search) {
    const rx = new RegExp(escapeRegex(filters.search), 'i');
    filter.$or = [{ title: rx }, { number: rx }];
  }
  return paginate(PurchaseRequest, filter, pagination, { select: '-history', populate: POPULATE.slice(0, 4) });
}

export async function getById(ctx, id) {
  const pr = await load(ctx, id);
  return reload(pr._id);
}

export async function create(ctx, data) {
  if (data.vendor) await loadVendor(ctx, data.vendor, { activeOnly: true });
  const { items, amount } = totals(data);
  const attachments = await uploads.resolve(ctx, data.attachments);
  const pr = await PurchaseRequest.create({
    society: ctx.societyId,
    number: await nextNumber(ctx.societyId, 'purchase_request', 'PR'),
    title: data.title,
    vendor: data.vendor,
    items,
    amount,
    justification: data.justification,
    attachments,
    requestedBy: ctx.userId,
    history: [{ by: ctx.userId, to: 'draft' }],
  });
  audit.record(ctx, 'purchase_request.created', 'PurchaseRequest', pr._id, { number: pr.number, amount });
  if (data.submit) return submit(ctx, pr._id);
  refresh(ctx.societyId, ['purchaseRequests']);
  return reload(pr._id);
}

export async function update(ctx, id, data) {
  const pr = await load(ctx, id);
  if (!sameUser(pr.requestedBy, ctx.userId)) throw ApiError.forbidden('Only the requester can edit a request');
  if (pr.status !== 'draft') throw ApiError.conflict('Only draft requests can be edited');
  if (data.vendor) await loadVendor(ctx, data.vendor, { activeOnly: true });
  if (data.items || data.amount !== undefined) {
    const t = totals({ items: data.items ?? pr.items, amount: data.amount ?? pr.amount });
    pr.items = t.items;
    pr.amount = t.amount;
  }
  for (const k of ['title', 'justification']) if (data[k] !== undefined) pr[k] = data[k];
  if (data.vendor !== undefined) pr.vendor = data.vendor || undefined;
  if (data.attachments) pr.attachments = await uploads.resolve(ctx, data.attachments);
  await pr.save();
  refresh(ctx.societyId, ['purchaseRequests']);
  return reload(pr._id);
}

export async function remove(ctx, id) {
  const pr = await load(ctx, id);
  if (!sameUser(pr.requestedBy, ctx.userId)) throw ApiError.forbidden('Only the requester can delete a request');
  if (pr.status !== 'draft') throw ApiError.conflict('Only draft requests can be deleted');
  await pr.deleteOne();
  refresh(ctx.societyId, ['purchaseRequests']);
}

export async function submit(ctx, id) {
  const pr = await load(ctx, id);
  if (!sameUser(pr.requestedBy, ctx.userId)) throw ApiError.forbidden('Only the requester can submit a request');
  if (pr.status !== 'draft') throw ApiError.conflict('Request is already {status}', { params: { status: pr.status } });
  const { autoApproveLimit } = await getSettings(ctx);
  if (autoApproveLimit > 0 && pr.amount <= autoApproveLimit) {
    // Small purchases within the committee's standing limit are approved without a second person.
    transition(pr, ctx.userId, 'pending');
    transition(pr, undefined, 'approved', `Auto-approved (within ${money(autoApproveLimit)} limit)`);
    pr.autoApproved = true;
    pr.decidedAt = new Date();
    await pr.save();
    audit.record(ctx, 'purchase_request.auto_approved', 'PurchaseRequest', pr._id, { number: pr.number, amount: pr.amount });
    refresh(ctx.societyId, ['purchaseRequests']);
    return reload(pr._id);
  }
  transition(pr, ctx.userId, 'pending');
  await pr.save();
  await notifyRoles(ctx.societyId, [ROLES.ADMIN], {
    type: 'purchase_request',
    title: `Purchase request ${pr.number} needs approval`,
    body: `${pr.title} · ${money(pr.amount)}`,
    link: link(pr),
  });
  audit.record(ctx, 'purchase_request.submitted', 'PurchaseRequest', pr._id, { number: pr.number, amount: pr.amount });
  refresh(ctx.societyId, ['purchaseRequests']);
  return reload(pr._id);
}

async function decide(ctx, id, to, note) {
  const pr = await PurchaseRequest.findOne({ _id: id, society: ctx.societyId });
  if (!pr) throw ApiError.notFound('Purchase request not found');
  if (pr.status !== 'pending') throw ApiError.conflict('Request is {status}, not pending', { params: { status: pr.status } });
  if (sameUser(pr.requestedBy, ctx.userId)) throw ApiError.forbidden('You cannot approve or reject your own request (maker-checker)');
  transition(pr, ctx.userId, to, note);
  pr.decidedBy = ctx.userId;
  pr.decidedAt = new Date();
  pr.decisionNote = note;
  await pr.save();
  await notifyUsers(ctx.societyId, [pr.requestedBy], {
    type: 'purchase_request',
    title: `Purchase request ${pr.number} ${to}`,
    body: note ? `${pr.title} · ${note}` : pr.title,
    link: link(pr),
  });
  audit.record(ctx, `purchase_request.${to}`, 'PurchaseRequest', pr._id, { number: pr.number, amount: pr.amount, note });
  refresh(ctx.societyId, ['purchaseRequests']);
  return reload(pr._id);
}

export const approve = (ctx, id, { note } = {}) => decide(ctx, id, 'approved', note);
export const reject = (ctx, id, { note }) => decide(ctx, id, 'rejected', note);

// Used by vendor bills: an approved request becomes "converted" once billed.
export async function claimForBill(ctx, id, vendorId) {
  const pr = await PurchaseRequest.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!pr) throw ApiError.badRequest('Purchase request not found');
  if (pr.status !== 'approved') throw ApiError.conflict('Purchase request {number} is {status}; only approved requests can be billed', { params: { number: pr.number, status: pr.status } });
  if (pr.vendor && vendorId && String(pr.vendor) !== String(vendorId)) throw ApiError.badRequest('Purchase request {number} is for a different vendor', { params: { number: pr.number } });
  return pr;
}

export async function markConverted(ctx, id, billId, by) {
  const res = await PurchaseRequest.updateOne(
    { _id: id, society: ctx.societyId, status: 'approved' },
    { $set: { status: 'converted', vendorBill: billId }, $push: { history: { by, from: 'approved', to: 'converted', createdAt: new Date() } } },
  );
  if (!res.modifiedCount) throw ApiError.conflict('Purchase request was already billed');
}

export async function releaseFromBill(ctx, id, by) {
  await PurchaseRequest.updateOne(
    { _id: id, society: ctx.societyId, status: 'converted' },
    { $set: { status: 'approved' }, $unset: { vendorBill: 1 }, $push: { history: { by, from: 'converted', to: 'approved', note: 'Vendor bill cancelled', createdAt: new Date() } } },
  );
}
