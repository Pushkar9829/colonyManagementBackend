import Asset from './asset.model.js';
import AssetEvent from './assetEvent.model.js';
import AmcVisit from './amcVisit.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { nextNumber } from '../counter/counter.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { invalidate } from '../../realtime/socket.js';
import { addDaysStr, diffDays, today } from './facility.shared.js';

const POPULATE = [{ path: 'block', select: 'name' }];

async function load(ctx, id) {
  const asset = await Asset.findOne({ _id: id, society: ctx.societyId });
  if (!asset) throw ApiError.notFound('Asset not found');
  return asset;
}

// AMC / warranty state derived for the UI.
export function present(doc, now = new Date()) {
  const a = doc.toObject ? doc.toObject() : { ...doc };
  const t = today(now);
  delete a.alertsSent;
  a.amcStatus = !a.amc?.endDate ? 'none' : a.amc.endDate < t ? 'expired' : diffDays(t, a.amc.endDate) <= 30 ? 'expiring' : 'active';
  a.amcDaysLeft = a.amc?.endDate ? diffDays(t, a.amc.endDate) : null;
  a.warrantyStatus = !a.warrantyExpiry ? 'none' : a.warrantyExpiry < t ? 'expired' : diffDays(t, a.warrantyExpiry) <= 30 ? 'expiring' : 'active';
  a.warrantyDaysLeft = a.warrantyExpiry ? diffDays(t, a.warrantyExpiry) : null;
  return a;
}

// Appends to an asset's service-history timeline. Used by maintenance / work orders too.
export async function recordEvent(ctx, assetId, { type, title, notes, cost, date, ref, attachments = [] }) {
  if (!assetId) return null;
  return AssetEvent.create({ society: ctx.societyId, asset: assetId, type, title, notes, cost, date: date || today(), ref, attachments, by: ctx.userId || undefined });
}

// Lets other facility modules check an asset id belongs to this society (and read its name).
export async function findForSociety(ctx, id, select = 'name code category location status') {
  if (!id) return null;
  const asset = await Asset.findOne({ _id: id, society: ctx.societyId }).select(select).lean();
  if (!asset) throw ApiError.badRequest('Asset not found in this society');
  return asset;
}

export async function setStatusQuietly(ctx, assetId, status, title) {
  const asset = await Asset.findOne({ _id: assetId, society: ctx.societyId });
  if (!asset || asset.status === status || asset.status === 'retired') return;
  const from = asset.status;
  asset.status = status;
  await asset.save();
  await recordEvent(ctx, asset._id, { type: 'status_changed', title: title || `Status ${from} → ${status}` });
}

export async function create(ctx, data) {
  const { photos: photoIds, documents: docIds, ...fields } = data;
  const [photos, documents] = await Promise.all([uploads.resolve(ctx, photoIds), uploads.resolve(ctx, docIds)]);
  const asset = await Asset.create({
    ...fields,
    photos,
    documents,
    society: ctx.societyId,
    code: await nextNumber(ctx.societyId, 'asset', 'AST'),
    createdBy: ctx.userId,
  });
  await recordEvent(ctx, asset._id, { type: 'created', title: 'Asset registered' });
  audit.record(ctx, 'asset.created', 'Asset', asset._id, { code: asset.code, name: asset.name });
  invalidate(ctx.societyId, ['assets'], { roles: ['staff'] });
  return getById(ctx, asset._id);
}

export async function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.category) filter.category = filters.category;
  if (filters.status) filter.status = filters.status;
  if (filters.block) filter.block = filters.block;
  if (filters.search) {
    const rx = new RegExp(escapeRegex(filters.search), 'i');
    filter.$or = [{ name: rx }, { code: rx }, { tag: rx }, { location: rx }, { serialNumber: rx }, { make: rx }];
  }
  if (filters.expiring) {
    const t = today();
    const until = addDaysStr(t, filters.expiring);
    const window = { $gte: t, $lte: until };
    filter.$and = [{ $or: [{ 'amc.endDate': window }, { warrantyExpiry: window }] }];
  }
  const result = await paginate(Asset, filter, pagination, { populate: POPULATE, select: '-amcHistory', sort: { code: 1 } });
  result.items = result.items.map((a) => present(a));
  return result;
}

export async function getById(ctx, id) {
  const asset = await Asset.findOne({ _id: id, society: ctx.societyId }).populate(POPULATE).lean();
  if (!asset) throw ApiError.notFound('Asset not found');
  return { ...present(asset), amcVisits: await amcVisitSummary(ctx, asset) };
}

// Physical tag or generated code: both may be printed on the equipment.
export async function getByCode(ctx, code) {
  const value = code.trim();
  const asset = await Asset.findOne({ society: ctx.societyId, $or: [{ code: value.toUpperCase() }, { tag: value }] }).select('_id code name').lean();
  if (!asset) throw ApiError.notFound('No asset with this code');
  return asset;
}

export async function update(ctx, id, data) {
  const asset = await load(ctx, id);
  const $set = {};
  const $unset = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null) $unset[k] = 1;
    else $set[k] = v;
  }
  await Asset.updateOne({ _id: asset._id }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) }, { runValidators: true });
  await recordEvent(ctx, asset._id, { type: 'updated', title: 'Details updated', notes: Object.keys(data).join(', ') });
  audit.record(ctx, 'asset.updated', 'Asset', asset._id, { fields: Object.keys(data) });
  return getById(ctx, asset._id);
}

export async function changeStatus(ctx, id, { status, note }) {
  const asset = await load(ctx, id);
  if (asset.status === status) throw ApiError.conflict('Asset is already {status}', { params: { status: status.replace('_', ' ') } });
  const from = asset.status;
  asset.status = status;
  await asset.save();
  await recordEvent(ctx, asset._id, { type: 'status_changed', title: `Status ${from.replace('_', ' ')} → ${status.replace('_', ' ')}`, notes: note });
  audit.record(ctx, 'asset.status_changed', 'Asset', asset._id, { from, to: status });
  return getById(ctx, asset._id);
}

export async function addFiles(ctx, id, { kind, uploads: ids }) {
  const asset = await load(ctx, id);
  const files = await uploads.resolve(ctx, ids);
  if (asset[kind].length + files.length > 20) throw ApiError.badRequest('An asset can hold at most 20 files of each kind');
  asset[kind].push(...files);
  await asset.save();
  return getById(ctx, asset._id);
}

export async function removeFile(ctx, id, { kind, url }) {
  const asset = await load(ctx, id);
  const list = kind === 'amc' ? asset.amc?.documents : asset[kind];
  const idx = (list || []).findIndex((f) => f.url === url);
  if (idx < 0) throw ApiError.notFound('File not found on this asset');
  list.splice(idx, 1);
  await asset.save();
  return getById(ctx, asset._id);
}

export async function setAmc(ctx, id, { renew, documents: docIds, ...amc }) {
  const asset = await load(ctx, id);
  const documents = await uploads.resolve(ctx, docIds);
  if (renew && asset.amc?.endDate) {
    if (amc.startDate < asset.amc.startDate) throw ApiError.badRequest('A renewed contract cannot start before the current one');
    asset.amcHistory.push(asset.amc.toObject());
    asset.amc = { ...amc, documents };
  } else {
    asset.amc = { ...amc, documents: [...(asset.amc?.documents || []), ...documents] };
  }
  // a new end date deserves a fresh set of reminders
  asset.alertsSent = asset.alertsSent.filter((k) => !k.startsWith('amc:'));
  await asset.save();
  await recordEvent(ctx, asset._id, {
    type: 'amc_renewed',
    title: `${renew ? 'AMC renewed' : 'AMC saved'} with ${amc.vendorName}`,
    notes: `${amc.startDate} to ${amc.endDate}${amc.contractNumber ? ` · ${amc.contractNumber}` : ''}`,
    cost: amc.cost || undefined,
  });
  audit.record(ctx, renew ? 'asset.amc_renewed' : 'asset.amc_saved', 'Asset', asset._id, { vendorName: amc.vendorName, endDate: amc.endDate, cost: amc.cost });
  return getById(ctx, asset._id);
}

// Visits done vs due for the current contract. Due-to-date grows linearly across the contract term.
async function amcVisitSummary(ctx, asset, now = new Date()) {
  const amc = asset.amc;
  if (!amc?.startDate || !amc?.endDate) return null;
  const done = await AmcVisit.countDocuments({ society: ctx.societyId, asset: asset._id, date: { $gte: amc.startDate, $lte: amc.endDate } });
  const term = Math.max(1, diffDays(amc.startDate, amc.endDate) + 1);
  const total = Math.round(((amc.visitsPerYear || 0) * term) / 365);
  const elapsed = Math.min(term, Math.max(0, diffDays(amc.startDate, today(now)) + 1));
  const dueToDate = Math.floor((total * elapsed) / term);
  return { done, total, dueToDate, behind: Math.max(0, dueToDate - done) };
}

export async function addAmcVisit(ctx, id, { attachments: ids, ...data }) {
  const asset = await load(ctx, id);
  if (!asset.amc?.startDate) throw ApiError.conflict('Add an AMC contract to this asset first');
  const attachments = await uploads.resolve(ctx, ids);
  const visit = await AmcVisit.create({ ...data, attachments, society: ctx.societyId, asset: asset._id, contractNumber: asset.amc.contractNumber, by: ctx.userId });
  await recordEvent(ctx, asset._id, { type: 'amc_visit', title: `AMC ${data.type} visit${data.technician ? ` by ${data.technician}` : ''}`, notes: data.findings, date: data.date, attachments, ref: { kind: 'AmcVisit', id: visit._id } });
  return visit.toObject();
}

export async function listAmcVisits(ctx, id) {
  await load(ctx, id);
  return AmcVisit.find({ society: ctx.societyId, asset: id }).sort({ date: -1 }).populate({ path: 'by', select: 'name' }).limit(200).lean();
}

export async function addServiceEvent(ctx, id, { attachments: ids, ...data }) {
  const asset = await load(ctx, id);
  const attachments = await uploads.resolve(ctx, ids);
  const event = await recordEvent(ctx, asset._id, { ...data, attachments });
  return event.toObject();
}

export async function timeline(ctx, id, pagination) {
  await load(ctx, id);
  return paginate(AssetEvent, { society: ctx.societyId, asset: id }, pagination, { populate: { path: 'by', select: 'name' } });
}

export async function stats(ctx) {
  const t = today();
  const in30 = addDaysStr(t, 30);
  const [byStatus, amcExpiring, warrantyExpiring, amcExpired] = await Promise.all([
    Asset.aggregate([{ $match: { society: ctx.societyId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Asset.countDocuments({ society: ctx.societyId, status: { $ne: 'retired' }, 'amc.endDate': { $gte: t, $lte: in30 } }),
    Asset.countDocuments({ society: ctx.societyId, status: { $ne: 'retired' }, warrantyExpiry: { $gte: t, $lte: in30 } }),
    Asset.countDocuments({ society: ctx.societyId, status: { $ne: 'retired' }, 'amc.endDate': { $lt: t } }),
  ]);
  const counts = Object.fromEntries(byStatus.map((r) => [r._id, r.count]));
  return {
    total: byStatus.reduce((s, r) => s + r.count, 0),
    working: counts.working || 0,
    underRepair: counts.under_repair || 0,
    retired: counts.retired || 0,
    amcExpiring,
    amcExpired,
    warrantyExpiring,
  };
}
