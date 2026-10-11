import Employee from './employee.model.js';
import StaffShift from './staffShift.model.js';
import StaffhrSettings from './staffhrSettings.model.js';
import Membership from '../users/membership.model.js';
import User from '../users/user.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { ROLES, STAFF_ROLES } from '../../common/constants/index.js';
import { nextNumber } from '../counter/counter.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';

// Roles that can hold an employee profile: everyone on the society payroll.
export const EMPLOYEE_ROLES = [...STAFF_ROLES, ROLES.ADMIN];
const HR_VIEWERS = [ROLES.ADMIN, ROLES.FACILITY_MANAGER, ROLES.ACCOUNTANT];
const POPULATE = [
  { path: 'user', select: 'name email phone' },
  { path: 'membership', select: 'role status designation' },
  { path: 'defaultShift', select: 'name start end' },
];

// ---- settings ----
export async function getSettings(ctx) {
  const doc = await StaffhrSettings.findOneAndUpdate({ society: ctx.societyId }, { $setOnInsert: { society: ctx.societyId } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }).lean();
  return doc;
}

export async function updateSettings(ctx, data) {
  const $set = { updatedBy: ctx.userId };
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [kk, vv] of Object.entries(v)) $set[`${k}.${kk}`] = vv;
    else $set[k] = v;
  }
  const doc = await StaffhrSettings.findOneAndUpdate({ society: ctx.societyId }, { $set }, { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true }).lean();
  audit.record(ctx, 'staffhr.settings_updated', 'StaffhrSettings', doc._id, { fields: Object.keys(data) });
  return doc;
}

// ---- employees ----
function maskSensitive(data) {
  const out = { ...data };
  if (data.bank) {
    out.bank = { ...data.bank };
    if (data.bank.accountNumber) out.bank.accountLast4 = data.bank.accountNumber.slice(-4);
  }
  if (data.pan) out.panLast4 = data.pan.slice(-4);
  return out;
}

// Flattens nested objects so a partial update never wipes sibling fields (e.g. bank.ifsc).
function toSet(data) {
  const $set = {};
  const $unset = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null) $unset[k] = 1;
    else if (['bank', 'emergencyContact', 'policeVerification'].includes(k)) for (const [kk, vv] of Object.entries(v)) $set[`${k}.${kk}`] = vv;
    else $set[k] = v;
  }
  return { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) };
}

async function assertShift(ctx, id) {
  if (id && !(await StaffShift.exists({ _id: id, society: ctx.societyId }))) throw ApiError.badRequest('Shift not found');
}

export async function create(ctx, { membership: membershipId, documents: docIds, ...data }) {
  const m = await Membership.findOne({ _id: membershipId, society: ctx.societyId, role: { $in: EMPLOYEE_ROLES }, status: 'active' }).lean();
  if (!m) throw ApiError.badRequest('Pick an active staff member of this society');
  if (await Employee.exists({ society: ctx.societyId, membership: m._id })) throw ApiError.conflict('This person already has an employee profile');
  await assertShift(ctx, data.defaultShift);
  const documents = await uploads.resolve(ctx, docIds);
  const employeeCode = data.employeeCode?.toUpperCase() || (await nextNumber(ctx.societyId, 'employee', 'EMP', 4));
  const user = await User.findById(m.user).select('name').lean();
  const emp = await Employee.create({ ...maskSensitive(data), designation: data.designation || m.designation, employeeCode, documents, society: ctx.societyId, membership: m._id, user: m.user });
  audit.record(ctx, 'employee.created', 'Employee', emp._id, { employeeCode, name: user?.name });
  return getById(ctx, emp._id);
}

export async function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.status) filter.status = filters.status;
  if (filters.department) filter.department = filters.department;
  if (filters.search) {
    const rx = new RegExp(escapeRegex(filters.search), 'i');
    const users = await User.find({ name: rx }).select('_id').limit(200).lean();
    filter.$or = [{ employeeCode: rx }, { designation: rx }, { user: { $in: users.map((u) => u._id) } }];
  }
  return paginate(Employee, filter, pagination, { sort: { employeeCode: 1 }, populate: POPULATE });
}

export async function getById(ctx, id) {
  const emp = await Employee.findOne({ _id: id, society: ctx.societyId }).populate(POPULATE).lean();
  if (!emp) throw ApiError.notFound('Employee not found');
  if (!HR_VIEWERS.includes(ctx.role) && String(emp.user._id) !== String(ctx.userId)) throw ApiError.notFound('Employee not found');
  return emp;
}

export async function findMine(ctx, { required = true } = {}) {
  const emp = await Employee.findOne({ society: ctx.societyId, user: ctx.userId, status: 'active' }).populate(POPULATE).lean();
  if (!emp && required) throw ApiError.notFound('You do not have an employee profile in this society yet. Ask the facility manager to add you.');
  return emp;
}

export async function update(ctx, id, { documents: docIds, ...data }) {
  const emp = await Employee.findOne({ _id: id, society: ctx.societyId });
  if (!emp) throw ApiError.notFound('Employee not found');
  if (data.defaultShift) await assertShift(ctx, data.defaultShift);
  if (data.employeeCode) data.employeeCode = data.employeeCode.toUpperCase();
  const update = toSet(maskSensitive(data));
  if (docIds?.length) update.$push = { documents: { $each: await uploads.resolve(ctx, docIds) } };
  await Employee.updateOne({ _id: emp._id }, update, { runValidators: true });
  // Salary and bank changes matter for payroll; record which fields changed, never the values.
  audit.record(ctx, 'employee.updated', 'Employee', emp._id, { fields: Object.keys(data) });
  return getById(ctx, emp._id);
}

export async function removeDocument(ctx, id, url) {
  const res = await Employee.updateOne({ _id: id, society: ctx.societyId }, { $pull: { documents: { url } } });
  if (!res.matchedCount) throw ApiError.notFound('Employee not found');
  return getById(ctx, id);
}

// Staff memberships that have no employee profile yet (for the "add employee" picker).
export async function candidates(ctx) {
  const [members, existing] = await Promise.all([
    Membership.find({ society: ctx.societyId, role: { $in: EMPLOYEE_ROLES }, status: 'active' }).populate({ path: 'user', select: 'name email phone' }).lean(),
    Employee.find({ society: ctx.societyId }).select('membership').lean(),
  ]);
  const taken = new Set(existing.map((e) => String(e.membership)));
  return members.filter((m) => !taken.has(String(m._id)) && m.user).map((m) => ({ membership: m._id, user: m.user, role: m.role, designation: m.designation }));
}

// Full account number, for the payout file. Accountants and admins only (enforced in routes).
export async function bankDetails(ctx, id) {
  const emp = await Employee.findOne({ _id: id, society: ctx.societyId }).select('+bank.accountNumber').lean();
  if (!emp) throw ApiError.notFound('Employee not found');
  audit.record(ctx, 'employee.bank_viewed', 'Employee', id);
  return { employeeCode: emp.employeeCode, ...emp.bank };
}

export const activeEmployees = (ctx, select) => Employee.find({ society: ctx.societyId, status: 'active' }).select(select).lean();

// ---- shifts ----
export const listShifts = (ctx) => StaffShift.find({ society: ctx.societyId }).sort({ active: -1, start: 1 }).lean();
export const createShift = async (ctx, data) => (await StaffShift.create({ ...data, society: ctx.societyId })).toObject();
export async function updateShift(ctx, id, data) {
  const doc = await StaffShift.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: data }, { returnDocument: 'after', runValidators: true }).lean();
  if (!doc) throw ApiError.notFound('Shift not found');
  return doc;
}
