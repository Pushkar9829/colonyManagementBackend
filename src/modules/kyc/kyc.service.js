import KycDocument, { categoryOf } from './kycDocument.model.js';
import Membership from '../users/membership.model.js';
import Unit from '../units/unit.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { ROLES } from '../../common/constants/index.js';
import * as uploads from '../uploads/uploads.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';

const isAdmin = (ctx) => ctx.role === ROLES.ADMIN;
const POPULATE = [
  { path: 'user', select: 'name phone email' },
  { path: 'unit', select: 'label' },
  { path: 'reviewedBy', select: 'name' },
];
const typeLabel = (t) => t.replace(/_/g, ' ');

// What every resident needs: an ID proof and a photo. Owners also need one ownership document.
const REQUIRED_PERSONAL = ['id_proof', 'photo'];

function membershipOf(ctx) {
  const id = ctx.user?.membershipId;
  if (!id) throw ApiError.forbidden('Open a society membership first');
  return id;
}

export async function submit(ctx, { type, number, nameOnDocument, files }) {
  const membershipId = membershipOf(ctx);
  const category = categoryOf(type);
  if (category === 'ownership' && !(ctx.role === ROLES.RESIDENT && ctx.user.residentType === 'owner')) {
    throw ApiError.forbidden('Only owners can submit ownership documents');
  }
  const existing = await KycDocument.findOne({ society: ctx.societyId, membership: membershipId, type });
  if (existing?.status === 'verified') throw ApiError.conflict('This document is already verified. Ask the office to reject it first if it needs replacing.');

  const attachments = await uploads.resolve(ctx, files);
  const fields = {
    society: ctx.societyId,
    unit: ctx.unitId || undefined,
    membership: membershipId,
    user: ctx.userId,
    type,
    category,
    last4: number ? number.slice(-4) : undefined, // the full number is dropped here and never persisted
    nameOnDocument,
    files: attachments,
    status: 'pending',
    rejectionReason: undefined,
    reviewedBy: undefined,
    reviewedAt: undefined,
  };
  const doc = existing ? Object.assign(existing, fields) : new KycDocument(fields);
  await doc.save();
  audit.record(ctx, 'kyc.submitted', 'KycDocument', doc._id, { type });
  await notifyRoles(ctx.societyId, [ROLES.ADMIN], {
    type: 'kyc',
    title: 'KYC document to verify',
    body: `${ctx.user?.name || 'A member'} submitted ${typeLabel(type)}`,
    link: '/kyc',
  });
  return KycDocument.findById(doc._id).populate(POPULATE).lean();
}

function statusFor(docs, residentType) {
  const required = residentType === 'owner' ? [...REQUIRED_PERSONAL, 'ownership'] : REQUIRED_PERSONAL;
  const items = required.map((category) => {
    const inCat = docs.filter((d) => d.category === category);
    let status = 'missing';
    if (inCat.some((d) => d.status === 'verified')) status = 'verified';
    else if (inCat.some((d) => d.status === 'pending')) status = 'pending';
    else if (inCat.length) status = 'rejected';
    return { category, status };
  });
  const done = items.filter((i) => i.status === 'verified').length;
  return { items, done, required: required.length, complete: done === required.length };
}

export async function mine(ctx) {
  const docs = await KycDocument.find({ society: ctx.societyId, membership: membershipOf(ctx) }).populate(POPULATE).sort({ createdAt: -1 }).lean();
  return { documents: docs, completion: statusFor(docs, ctx.role === ROLES.RESIDENT ? ctx.user.residentType : null) };
}

// Only the member who uploaded a document and society admins can see it.
export async function getById(ctx, id) {
  const filter = { _id: id, society: ctx.societyId };
  if (!isAdmin(ctx)) filter.user = ctx.userId;
  const doc = await KycDocument.findOne(filter).populate(POPULATE).lean();
  if (!doc) throw ApiError.notFound('Document not found');
  return doc;
}

export async function removeMine(ctx, id) {
  const doc = await KycDocument.findOne({ _id: id, society: ctx.societyId, user: ctx.userId });
  if (!doc) throw ApiError.notFound('Document not found');
  if (doc.status === 'verified') throw ApiError.conflict('Verified documents cannot be deleted');
  await doc.deleteOne();
}

export function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.status) filter.status = filters.status;
  if (filters.type) filter.type = filters.type;
  if (filters.unit) filter.unit = filters.unit;
  // The pending queue is worked oldest first.
  return paginate(KycDocument, filter, pagination, { sort: { createdAt: filters.status === 'pending' ? 1 : -1 }, populate: POPULATE });
}

async function review(ctx, id, verified, reason) {
  const doc = await KycDocument.findOneAndUpdate(
    { _id: id, society: ctx.societyId, status: { $in: verified ? ['pending', 'rejected'] : ['pending', 'verified'] } },
    verified
      ? { status: 'verified', $unset: { rejectionReason: 1 }, reviewedBy: ctx.userId, reviewedAt: new Date() }
      : { status: 'rejected', rejectionReason: reason, reviewedBy: ctx.userId, reviewedAt: new Date() },
    { returnDocument: 'after' },
  )
    .populate(POPULATE)
    .lean();
  if (!doc) throw ApiError.conflict(`Document not found or already ${verified ? 'verified' : 'rejected'}`);
  audit.record(ctx, verified ? 'kyc.verified' : 'kyc.rejected', 'KycDocument', doc._id, { type: doc.type, reason });
  await notifyUsers(ctx.societyId, [doc.user._id], {
    type: 'kyc',
    title: `Your ${typeLabel(doc.type)} was ${verified ? 'verified' : 'rejected'}`,
    body: verified ? 'Thank you for completing your KYC.' : reason,
    link: '/household?tab=kyc',
  });
  return doc;
}

export const verify = (ctx, id) => review(ctx, id, true);
export const reject = (ctx, id, reason) => review(ctx, id, false, reason);

// KYC completion per unit: each active resident's personal documents, plus ownership proof for owners.
export async function completion(ctx, filters, { page, limit, skip }) {
  const [allUnits, members, docs] = await Promise.all([
    Unit.find({ society: ctx.societyId }).sort({ label: 1 }).select('label occupancy').lean(),
    Membership.find({ society: ctx.societyId, role: ROLES.RESIDENT, status: 'active', unit: { $ne: null } }).populate('user', 'name').select('user unit residentType').lean(),
    KycDocument.find({ society: ctx.societyId }).select('membership category status').lean(),
  ]);
  const docsByMember = new Map();
  for (const d of docs) {
    const k = String(d.membership);
    if (!docsByMember.has(k)) docsByMember.set(k, []);
    docsByMember.get(k).push(d);
  }
  let rows = allUnits.map((u) => {
    const residents = members
      .filter((m) => String(m.unit) === String(u._id))
      .map((m) => ({ membership: m._id, name: m.user?.name, residentType: m.residentType, ...statusFor(docsByMember.get(String(m._id)) || [], m.residentType) }));
    const required = residents.reduce((s, r) => s + r.required, 0);
    const done = residents.reduce((s, r) => s + r.done, 0);
    return { unit: u, residents, required, done, percent: required ? Math.round((done / required) * 100) : null, complete: required > 0 && done === required };
  });
  const occupied = rows.filter((r) => r.residents.length);
  const requiredAll = occupied.reduce((s, r) => s + r.required, 0);
  const summary = {
    units: allUnits.length,
    occupiedUnits: occupied.length,
    completeUnits: occupied.filter((r) => r.complete).length,
    pendingDocuments: docs.filter((d) => d.status === 'pending').length,
    percent: requiredAll ? Math.round((occupied.reduce((s, r) => s + r.done, 0) / requiredAll) * 100) : 0,
  };
  if (filters.incompleteOnly) rows = rows.filter((r) => r.residents.length && !r.complete);
  const total = rows.length;
  return { items: rows.slice(skip, skip + limit), meta: { page, limit, total, pages: Math.ceil(total / limit) || 1, summary } };
}
