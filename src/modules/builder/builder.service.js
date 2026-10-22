import Possession from './possession.model.js';
import Snag from './snag.model.js';
import ProgressUpdate from './progressUpdate.model.js';
import Handover from './handover.model.js';
import { handoverPdf } from './handoverPdf.js';
import Unit from '../units/unit.model.js';
import Society from '../society/society.model.js';
import { nextNumber } from '../counter/counter.service.js';
import * as uploads from '../uploads/uploads.service.js';
import { notifyRoles, notifyUnit } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';
import { sendEmailQuietly } from '../../integrations/email.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { toMinutes } from '../../common/utils/dates.js';
import { ROLES } from '../../common/constants/index.js';

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
// Builder staff are society admins whose designation says "Builder" (the developer runs the society
// until it is handed to the residents' association).
export const isBuilder = (ctx) => ctx.role === ROLES.ADMIN && /builder|developer/i.test(ctx.user?.designation || '');

export const DEFAULT_POSSESSION_CHECKLIST = [
  'Unit walk-through with the buyer',
  'Snag list reviewed with the buyer',
  'Electricity meter reading recorded',
  'Water meter reading recorded',
  'Possession letter and documents handed over',
  'Keys and access cards handed over',
];

export const DEFAULT_HANDOVER_ITEMS = [
  ['documents', 'Occupancy / completion certificate'],
  ['documents', 'Approved building plans and as-built drawings'],
  ['documents', 'Conveyance / deed of declaration'],
  ['documents', 'Fire NOC and lift licences'],
  ['documents', 'Warranties and AMC contracts for equipment'],
  ['funds', 'Corpus fund'],
  ['funds', 'Maintenance deposit balance'],
  ['funds', 'Sinking fund'],
  ['assets', 'DG set, transformers and electrical panels'],
  ['assets', 'Lifts'],
  ['assets', 'STP, WTP and pumps'],
  ['assets', 'Fire-fighting system'],
  ['assets', 'CCTV and access control'],
  ['assets', 'Clubhouse and gym equipment'],
  ['other', 'Keys to common areas, terrace and plant rooms'],
];

async function unitLabel(ctx, unitId) {
  const unit = await Unit.findOne({ _id: unitId, society: ctx.societyId }).select('label').lean();
  if (!unit) throw ApiError.badRequest('Unit not found in this society');
  return unit.label;
}

// ---------- possession scheduling ----------
async function assertSlotFree(ctx, { date, startTime, endTime }, exceptId) {
  if (toMinutes(endTime) <= toMinutes(startTime)) throw ApiError.badRequest('End time must be after start time');
  const sameDay = await Possession.find({ society: ctx.societyId, date, status: 'scheduled', ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).populate('unit', 'label').lean();
  const clash = sameDay.find((p) => toMinutes(p.startTime) < toMinutes(endTime) && toMinutes(startTime) < toMinutes(p.endTime));
  if (clash) throw ApiError.conflict('That slot overlaps the possession of {unit} ({start}-{end})', { params: { unit: clash.unit?.label, start: clash.startTime, end: clash.endTime } });
}

const POSSESSION_POPULATE = [{ path: 'unit', select: 'label' }, { path: 'completedBy', select: 'name' }];

export async function schedulePossession(ctx, data) {
  const label = await unitLabel(ctx, data.unit);
  if (await Possession.exists({ society: ctx.societyId, unit: data.unit, status: { $in: ['scheduled', 'completed'] } })) {
    throw ApiError.conflict('{unit} already has a possession appointment', { params: { unit: label } });
  }
  await assertSlotFree(ctx, data);
  const checklist = (data.checklist?.length ? data.checklist : DEFAULT_POSSESSION_CHECKLIST).map((item) => ({ item }));
  const doc = await Possession.create({ ...data, checklist, society: ctx.societyId, createdBy: ctx.userId });
  const when = `${data.date} ${data.startTime}-${data.endTime}`;
  await notifyUnit(ctx.societyId, data.unit, { type: 'builder', title: `Possession of ${label} scheduled`, body: when, link: '/builder' });
  if (data.buyerEmail) sendEmailQuietly({ to: data.buyerEmail, subject: `Possession appointment for ${label}`, text: `Dear ${data.buyerName},\n\nYour possession appointment for ${label} is on ${when}.\n\nPlease bring a photo ID.` });
  audit.record(ctx, 'builder.possession_scheduled', 'Possession', doc._id, { unit: label, when });
  return Possession.findById(doc._id).populate(POSSESSION_POPULATE).lean();
}

export function listPossessions(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  else if (filters.unit) filter.unit = filters.unit;
  if (filters.status) filter.status = filters.status;
  if (filters.from || filters.to) filter.date = { ...(filters.from ? { $gte: filters.from } : {}), ...(filters.to ? { $lte: filters.to } : {}) };
  return paginate(Possession, filter, pagination, { sort: { date: 1, startTime: 1 }, populate: POSSESSION_POPULATE });
}

async function loadPossession(ctx, id) {
  const doc = await Possession.findOne({ _id: id, society: ctx.societyId });
  if (!doc) throw ApiError.notFound('Possession appointment not found');
  return doc;
}

export async function updatePossession(ctx, id, data) {
  const doc = await loadPossession(ctx, id);
  if (doc.status !== 'scheduled') throw ApiError.conflict('This appointment is {status}', { params: { status: doc.status } });
  const moved = ['date', 'startTime', 'endTime'].some((k) => data[k] && data[k] !== doc[k]);
  if (moved) await assertSlotFree(ctx, { date: data.date || doc.date, startTime: data.startTime || doc.startTime, endTime: data.endTime || doc.endTime }, doc._id);
  for (const k of ['buyerName', 'buyerPhone', 'buyerEmail', 'date', 'startTime', 'endTime', 'notes']) if (data[k] !== undefined) doc[k] = data[k];
  for (const change of data.checklist || []) {
    const item = doc.checklist.id(change._id);
    if (!item) throw ApiError.badRequest('Unknown checklist item');
    if (change.done !== undefined) item.done = change.done;
    if (change.note !== undefined) item.note = change.note;
  }
  for (const item of data.addItems || []) doc.checklist.push({ item });
  await doc.save();
  if (moved) {
    const label = await unitLabel(ctx, doc.unit);
    await notifyUnit(ctx.societyId, doc.unit, { type: 'builder', title: `Possession of ${label} rescheduled`, body: `${doc.date} ${doc.startTime}-${doc.endTime}`, link: '/builder' });
  }
  return Possession.findById(doc._id).populate(POSSESSION_POPULATE).lean();
}

export async function completePossession(ctx, id, { note }) {
  const doc = await loadPossession(ctx, id);
  if (doc.status !== 'scheduled') throw ApiError.conflict('This appointment is {status}', { params: { status: doc.status } });
  const pending = doc.checklist.filter((c) => !c.done).map((c) => c.item);
  if (pending.length) throw ApiError.conflict('Finish the checklist first: {items}', { params: { items: pending.join(', ') } });
  doc.status = 'completed';
  doc.completedAt = new Date();
  doc.completedBy = ctx.userId;
  if (note) doc.notes = [doc.notes, note].filter(Boolean).join('\n');
  await doc.save();
  audit.record(ctx, 'builder.possession_completed', 'Possession', doc._id, {});
  return Possession.findById(doc._id).populate(POSSESSION_POPULATE).lean();
}

export async function cancelPossession(ctx, id, { reason }) {
  const doc = await loadPossession(ctx, id);
  if (doc.status !== 'scheduled') throw ApiError.conflict('This appointment is {status}', { params: { status: doc.status } });
  doc.status = 'cancelled';
  doc.notes = [doc.notes, `Cancelled: ${reason}`].filter(Boolean).join('\n');
  await doc.save();
  return Possession.findById(doc._id).populate(POSSESSION_POPULATE).lean();
}

// ---------- snags ----------
const SNAG_POPULATE = [
  { path: 'unit', select: 'label' },
  { path: 'raisedBy', select: 'name' },
  { path: 'signOff.by', select: 'name' },
  { path: 'history.by', select: 'name' },
];

function snagScope(ctx) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  return filter;
}

async function loadSnag(ctx, id) {
  const snag = await Snag.findOne({ ...snagScope(ctx), _id: id });
  if (!snag) throw ApiError.notFound('Snag not found');
  return snag;
}

const reloadSnag = (id) => Snag.findById(id).populate(SNAG_POPULATE).lean();

function moveSnag(snag, by, to, note) {
  snag.history.push({ by, from: snag.status, to, note });
  snag.status = to;
}

export async function createSnag(ctx, data) {
  // Buyers raise snags for their own unit during inspection; the builder team for any unit.
  const unit = isResident(ctx) ? ctx.unitId : data.unit;
  if (!unit) throw ApiError.badRequest('Choose a unit');
  const label = await unitLabel(ctx, unit);
  const photos = await uploads.resolve(ctx, data.photos);
  const snag = await Snag.create({
    ...data,
    unit,
    photos,
    contractor: isResident(ctx) ? undefined : data.contractor,
    society: ctx.societyId,
    number: await nextNumber(ctx.societyId, 'snag', 'SNG'),
    raisedBy: ctx.userId,
    history: [{ by: ctx.userId, to: 'open' }],
  });
  if (isResident(ctx)) await notifyRoles(ctx.societyId, [ROLES.ADMIN], { type: 'builder', title: `New snag in ${label}`, body: data.title, link: '/builder?tab=snags' });
  return reloadSnag(snag._id);
}

export async function listSnags(ctx, filters, pagination) {
  const filter = snagScope(ctx);
  if (!isResident(ctx) && filters.unit) filter.unit = filters.unit;
  if (filters.status) filter.status = filters.status;
  if (filters.category) filter.category = filters.category;
  if (filters.open) filter.status = { $in: ['open', 'in_progress', 'reopened'] };
  return paginate(Snag, filter, pagination, { populate: SNAG_POPULATE.slice(0, 2), select: '-history' });
}

export async function snagSummary(ctx) {
  const match = snagScope(ctx);
  const rows = await Snag.aggregate([{ $match: match }, { $group: { _id: { unit: '$unit', status: '$status' }, n: { $sum: 1 } } }]);
  const units = await Unit.find({ _id: { $in: [...new Set(rows.map((r) => String(r._id.unit)))] } }).select('label').lean();
  const label = new Map(units.map((u) => [String(u._id), u.label]));
  const byUnit = new Map();
  for (const r of rows) {
    const key = String(r._id.unit);
    const entry = byUnit.get(key) || { unit: { _id: r._id.unit, label: label.get(key) }, total: 0, open: 0, fixed: 0, verified: 0 };
    entry.total += r.n;
    if (['open', 'in_progress', 'reopened'].includes(r._id.status)) entry.open += r.n;
    else entry[r._id.status] += r.n;
    byUnit.set(key, entry);
  }
  return [...byUnit.values()].sort((a, b) => b.open - a.open || String(a.unit.label).localeCompare(String(b.unit.label)));
}

export const getSnag = async (ctx, id) => {
  await loadSnag(ctx, id);
  return reloadSnag(id);
};

const SNAG_TRANSITIONS = { open: ['in_progress', 'fixed'], reopened: ['in_progress', 'fixed'], in_progress: ['fixed'], fixed: [], verified: [] };

// Builder-side update: assign a contractor, progress the work, attach "after" photos.
export async function updateSnag(ctx, id, data) {
  const snag = await loadSnag(ctx, id);
  if (data.status && data.status !== snag.status) {
    if (!SNAG_TRANSITIONS[snag.status].includes(data.status)) throw ApiError.conflict('Cannot move a {from} snag to {to}', { params: { from: snag.status.replace('_', ' '), to: data.status.replace('_', ' ') } });
    moveSnag(snag, ctx.userId, data.status, data.note);
    if (data.status === 'fixed') snag.fixedAt = new Date();
  }
  if (data.contractor) snag.contractor = data.contractor;
  for (const k of ['title', 'description', 'category', 'location', 'targetDate']) if (data[k] !== undefined) snag[k] = data[k];
  if (data.fixPhotos?.length) snag.fixPhotos.push(...(await uploads.resolve(ctx, data.fixPhotos)));
  await snag.save();
  if (data.status === 'fixed') {
    await notifyUnit(ctx.societyId, snag.unit, { type: 'builder', title: `Snag ${snag.number} fixed`, body: `${snag.title} — please check and sign off`, link: '/builder?tab=snags' });
  }
  return reloadSnag(snag._id);
}

// The buyer accepts the fix. The builder can record a paper sign-off with the buyer's name.
export async function signOffSnag(ctx, id, { name, note }) {
  const snag = await loadSnag(ctx, id);
  if (snag.status !== 'fixed') throw ApiError.conflict('Only fixed snags can be signed off');
  if (!isResident(ctx) && !name) throw ApiError.badRequest('Enter the buyer’s name for a sign-off recorded on their behalf');
  snag.signOff = { by: ctx.userId, name: name || ctx.user?.name, at: new Date(), note };
  moveSnag(snag, ctx.userId, 'verified', note || 'Signed off by buyer');
  await snag.save();
  if (isResident(ctx)) await notifyRoles(ctx.societyId, [ROLES.ADMIN], { type: 'builder', title: `Snag ${snag.number} signed off`, body: snag.title, link: '/builder?tab=snags' });
  return reloadSnag(snag._id);
}

export async function reopenSnag(ctx, id, { note }) {
  const snag = await loadSnag(ctx, id);
  if (snag.status !== 'fixed') throw ApiError.conflict('Only fixed snags can be reopened');
  moveSnag(snag, ctx.userId, 'reopened', note);
  snag.fixedAt = undefined;
  await snag.save();
  if (isResident(ctx)) await notifyRoles(ctx.societyId, [ROLES.ADMIN], { type: 'builder', title: `Snag ${snag.number} reopened by buyer`, body: note, link: '/builder?tab=snags' });
  return reloadSnag(snag._id);
}

// ---------- construction progress ----------
export async function postProgress(ctx, data) {
  const photos = await uploads.resolve(ctx, data.photos);
  const doc = await ProgressUpdate.create({ ...data, photos, society: ctx.societyId, postedBy: ctx.userId });
  await notifyRoles(ctx.societyId, [ROLES.RESIDENT], { type: 'builder', title: `Construction update: ${data.title}`, body: data.milestone || data.body?.slice(0, 120), link: '/builder?tab=progress' });
  return ProgressUpdate.findById(doc._id).populate('postedBy', 'name').lean();
}

export const listProgress = (ctx, filters, pagination) =>
  paginate(ProgressUpdate, { society: ctx.societyId, ...(filters.tower ? { tower: filters.tower } : {}) }, pagination, { populate: { path: 'postedBy', select: 'name' } });

export async function removeProgress(ctx, id) {
  const res = await ProgressUpdate.deleteOne({ _id: id, society: ctx.societyId });
  if (!res.deletedCount) throw ApiError.notFound('Update not found');
  audit.record(ctx, 'builder.progress_deleted', 'ProgressUpdate', id, {});
}

// ---------- handover to the association ----------
async function handoverDoc(ctx) {
  const existing = await Handover.findOne({ society: ctx.societyId });
  if (existing) return existing;
  try {
    return await Handover.create({ society: ctx.societyId, items: DEFAULT_HANDOVER_ITEMS.map(([category, title]) => ({ category, title })) });
  } catch (err) {
    if (err.code === 11000) return Handover.findOne({ society: ctx.societyId });
    throw err;
  }
}

function presentHandover(doc) {
  const h = doc.toObject ? doc.toObject() : doc;
  const counted = h.items.filter((i) => i.status !== 'not_applicable');
  h.progress = { total: counted.length, transferred: counted.filter((i) => i.status === 'transferred').length };
  return h;
}

export const getHandover = async (ctx) => presentHandover(await handoverDoc(ctx));

// Any change to the list after a signature voids the signatures: both sides must sign the same list.
function resetSignatures(doc) {
  if (doc.status === 'completed') throw ApiError.conflict('The handover is complete and can no longer be changed');
  doc.builderSignOff = undefined;
  doc.associationSignOff = undefined;
  doc.status = 'in_progress';
}

export async function addHandoverItem(ctx, data) {
  const doc = await handoverDoc(ctx);
  resetSignatures(doc);
  doc.items.push(data);
  await doc.save();
  return presentHandover(doc);
}

export async function updateHandoverItem(ctx, itemId, data) {
  const doc = await handoverDoc(ctx);
  const item = doc.items.id(itemId);
  if (!item) throw ApiError.notFound('Item not found');
  resetSignatures(doc);
  Object.assign(item, data);
  if (data.status === 'transferred' && !item.transferredAt) item.transferredAt = new Date();
  if (data.status && data.status !== 'transferred') item.transferredAt = undefined;
  await doc.save();
  audit.record(ctx, 'builder.handover_item_updated', 'Handover', doc._id, { item: item.title, ...data });
  return presentHandover(doc);
}

export async function removeHandoverItem(ctx, itemId) {
  const doc = await handoverDoc(ctx);
  const item = doc.items.id(itemId);
  if (!item) throw ApiError.notFound('Item not found');
  resetSignatures(doc);
  item.deleteOne();
  await doc.save();
  return presentHandover(doc);
}

export async function signHandover(ctx, { side, name, note }) {
  const doc = await handoverDoc(ctx);
  if (doc.status === 'completed') throw ApiError.conflict('The handover is already complete');
  const pending = doc.items.filter((i) => i.status === 'pending');
  if (pending.length) throw ApiError.conflict('{count} item(s) are still pending. Mark them transferred or not applicable first.', { params: { count: pending.length } });
  // The builder signs as a "Builder" admin; the association through one of its own (non-builder) admins.
  if (side === 'builder' && !isBuilder(ctx)) throw ApiError.forbidden('Only a builder admin (designation "Builder") can sign for the builder');
  if (side === 'association' && isBuilder(ctx)) throw ApiError.forbidden('The association must sign through one of its own admins');
  const signature = { by: ctx.userId, name: name || ctx.user?.name, designation: ctx.user?.designation, note, at: new Date() };
  if (side === 'builder') doc.builderSignOff = signature;
  else doc.associationSignOff = signature;
  doc.status = doc.builderSignOff?.at && doc.associationSignOff?.at ? 'completed' : 'awaiting_signatures';
  if (doc.status === 'completed') doc.completedAt = new Date();
  await doc.save();
  audit.record(ctx, 'builder.handover_signed', 'Handover', doc._id, { side });
  if (doc.status === 'completed') await notifyRoles(ctx.societyId, [ROLES.ADMIN, ROLES.RESIDENT], { type: 'builder', title: 'Society handover completed', body: 'The builder has handed the society over to the association.', link: '/builder?tab=handover' });
  return presentHandover(doc);
}

export async function handoverPdfFile(ctx) {
  const doc = await Handover.findOne({ society: ctx.societyId }).populate('builderSignOff.by associationSignOff.by', 'name').lean();
  if (!doc) throw ApiError.notFound('No handover checklist yet');
  const society = await Society.findById(ctx.societyId).select('name code address city state pincode').lean();
  return { filename: `${society.code}-handover.pdf`, buffer: await handoverPdf({ society, handover: presentHandover(doc) }) };
}
