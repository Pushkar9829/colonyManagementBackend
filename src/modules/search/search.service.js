import mongoose from 'mongoose';
import Unit from '../units/unit.model.js';
import Membership from '../users/membership.model.js';
import Vehicle from '../vehicles/vehicle.model.js';
import Complaint from '../complaints/complaint.model.js';
import Bill from '../billing/bill.model.js';
import Visitor from '../visitors/visitor.model.js';
import Parcel from '../parcels/parcel.model.js';
import * as directory from '../directory/directory.service.js';
import { isEnabled } from '../features/features.service.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { money } from '../../common/utils/money.js';
import { ROLES } from '../../common/constants/index.js';

// Global search (command palette). Each group mirrors the authorize() rules and service scoping of the
// list endpoint it summarises, so search never shows a role more than it could already page through.
const { ADMIN, ACCOUNTANT, FACILITY_MANAGER, GUARD, RESIDENT, STAFF } = ROLES;
const LIMIT = 5;
const RECENT_VISITOR_MS = 30 * 86400000;

const human = (s) => (s ? String(s).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');
const joinParts = (...parts) => parts.filter(Boolean).join(' · ');
const item = (type, doc, title, subtitle, link) => ({ type, id: String(doc._id), title, subtitle, link });
const oid = (id) => new mongoose.Types.ObjectId(String(id));

// Pages each role can open for a result type (routes in frontend/src/app/router.jsx).
const UNIT_LINK = { [ADMIN]: '/units', [FACILITY_MANAGER]: '/households', [ACCOUNTANT]: '/billing', [GUARD]: '/gate' };
const PEOPLE_LINK = { [ADMIN]: '/members', [FACILITY_MANAGER]: '/households', [ACCOUNTANT]: '/directory', [GUARD]: '/gate', [RESIDENT]: '/directory' };

// GET /units — admin, accountant, facility manager, guard.
async function units(ctx, rx) {
  const docs = await Unit.find({ society: ctx.societyId, label: rx }).select('label type occupancy').sort({ label: 1 }).limit(LIMIT).lean();
  return docs.map((u) => item('unit', u, u.label, joinParts(human(u.type), human(u.occupancy)), UNIT_LINK[ctx.role]));
}

// GET /users — admin, facility manager, accountant: name, email and phone are all searchable and shown.
async function people(ctx, rx) {
  const rows = await Membership.aggregate([
    { $match: { society: oid(ctx.societyId), support: { $ne: true }, status: { $in: ['active', 'pending'] } } },
    { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'user', pipeline: [{ $project: { name: 1, email: 1, phone: 1 } }] } },
    { $unwind: '$user' },
    { $match: { $or: [{ 'user.name': rx }, { 'user.email': rx }, { 'user.phone': rx }] } },
    { $sort: { 'user.name': 1 } },
    { $limit: LIMIT },
    { $lookup: { from: 'units', localField: 'unit', foreignField: '_id', as: 'unit', pipeline: [{ $project: { label: 1 } }] } },
    { $unwind: { path: '$unit', preserveNullAndEmptyArrays: true } },
  ]);
  return rows.map((m) =>
    item('person', m, m.user.name, joinParts(human(m.role), m.unit?.label, m.status === 'pending' && 'Pending', m.user.email, m.user.phone), PEOPLE_LINK[ctx.role]),
  );
}

// Guards look residents up by name to find their flat; contact details never leave the server here.
async function residentsForGuard(ctx, rx) {
  const rows = await Membership.aggregate([
    { $match: { society: oid(ctx.societyId), role: RESIDENT, status: 'active', support: { $ne: true } } },
    { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'user', pipeline: [{ $project: { name: 1 } }] } },
    { $unwind: '$user' },
    { $match: { 'user.name': rx } },
    { $sort: { 'user.name': 1 } },
    { $limit: LIMIT },
    { $lookup: { from: 'units', localField: 'unit', foreignField: '_id', as: 'unit', pipeline: [{ $project: { label: 1 } }] } },
    { $unwind: { path: '$unit', preserveNullAndEmptyArrays: true } },
  ]);
  return rows.map((m) => item('person', m, m.user.name, m.unit?.label || '', PEOPLE_LINK[GUARD]));
}

// Residents see the society directory exactly as GET /directory builds it (opt-in + per-field privacy).
async function directoryPeople(ctx, _rx, q) {
  const { items } = await directory.list(ctx, { search: q }, { page: 1, limit: LIMIT, skip: 0 });
  return items.map((p) => item('person', p, p.name, joinParts((p.units || []).join(', '), p.profession, p.phone, p.email), PEOPLE_LINK[RESIDENT]));
}

// GET /vehicles — resident (own flat), guard, facility manager, admin.
async function vehicles(ctx, _rx, q) {
  const filter = { society: ctx.societyId, number: { $regex: escapeRegex(q.replace(/\s+/g, '').toUpperCase()) } };
  if (ctx.role === RESIDENT) {
    if (!ctx.unitId) return [];
    filter.unit = ctx.unitId;
  }
  const docs = await Vehicle.find(filter).select('number type make unit').populate('unit', 'label').sort({ number: 1 }).limit(LIMIT).lean();
  const link = ctx.role === RESIDENT ? '/vehicles' : '/vehicle-movements';
  return docs.map((v) => item('vehicle', v, v.number, joinParts(v.unit?.label, v.make, human(v.type)), link));
}

// GET /complaints — residents their own, staff what is assigned to them, managers everything.
async function complaints(ctx, rx) {
  const filter = { society: ctx.societyId, $or: [{ ticketNumber: rx }, { title: rx }] };
  if (ctx.role === RESIDENT) filter.raisedBy = ctx.userId;
  if (ctx.role === STAFF) filter.assignedTo = ctx.userId;
  const docs = await Complaint.find(filter).select('ticketNumber title status unit').populate('unit', 'label').sort({ createdAt: -1 }).limit(LIMIT).lean();
  return docs.map((c) => item('complaint', c, c.title, joinParts(c.ticketNumber, c.unit?.label, human(c.status)), `/complaints/${c._id}`));
}

// GET /bills — accountant and admin any unit, residents only the flat they have open.
async function bills(ctx, rx) {
  const filter = { society: ctx.societyId, billNumber: rx };
  if (ctx.role === RESIDENT) {
    if (!ctx.unitId) return [];
    filter.unit = ctx.unitId;
  }
  const docs = await Bill.find(filter).select('billNumber period status total unit').populate('unit', 'label').sort({ period: -1 }).limit(LIMIT).lean();
  return docs.map((b) => item('bill', b, b.billNumber, joinParts(b.unit?.label, b.period, money(b.total), human(b.status)), '/billing'));
}

// GET /visitors — guard, facility manager, admin; only the last 30 days so search stays on the recent index range.
async function visitors(ctx, rx) {
  const filter = { society: ctx.societyId, createdAt: { $gte: new Date(Date.now() - RECENT_VISITOR_MS) }, $or: [{ name: rx }, { phone: rx }] };
  const docs = await Visitor.find(filter).select('name phone purpose status unit createdAt').populate('unit', 'label').sort({ createdAt: -1 }).limit(LIMIT).lean();
  const showPhone = ctx.role !== GUARD;
  return docs.map((v) => item('visitor', v, v.name, joinParts(v.unit?.label, human(v.purpose), human(v.status), showPhone && v.phone), '/visitors'));
}

// GET /parcels — guard, facility manager, admin (switchable module).
async function parcels(ctx, rx) {
  if (!(await isEnabled(ctx.societyId, 'parcels'))) return [];
  const filter = { society: ctx.societyId, $or: [{ number: rx }, { trackingNo: rx }, { recipientName: rx }] };
  const docs = await Parcel.find(filter).select('number courier recipientName status unit').populate('unit', 'label').sort({ receivedAt: -1 }).limit(LIMIT).lean();
  return docs.map((p) => item('parcel', p, p.number, joinParts(p.unit?.label, p.courier, p.recipientName, human(p.status)), '/parcels'));
}

// Groups per role, in display order.
const PLAN = {
  [ADMIN]: [['unit', units], ['person', people], ['vehicle', vehicles], ['complaint', complaints], ['bill', bills], ['visitor', visitors], ['parcel', parcels]],
  [ACCOUNTANT]: [['unit', units], ['person', people], ['bill', bills]],
  [FACILITY_MANAGER]: [['unit', units], ['person', people], ['vehicle', vehicles], ['complaint', complaints], ['visitor', visitors], ['parcel', parcels]],
  [GUARD]: [['unit', units], ['person', residentsForGuard], ['vehicle', vehicles], ['visitor', visitors], ['parcel', parcels]],
  [RESIDENT]: [['complaint', complaints], ['bill', bills], ['vehicle', vehicles], ['person', directoryPeople]],
  [STAFF]: [['complaint', complaints]],
};

export async function search(ctx, q) {
  const text = q.trim();
  const rx = new RegExp(escapeRegex(text), 'i');
  const plan = PLAN[ctx.role] || [];
  const results = await Promise.all(plan.map(([, run]) => run(ctx, rx, text)));
  const groups = plan.map(([type], i) => ({ type, items: results[i] })).filter((g) => g.items.length);
  return { q: text, groups };
}
