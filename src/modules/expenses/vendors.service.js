import Vendor from './vendor.model.js';
import VendorBill from './vendorBill.model.js';
import VendorPayment from './vendorPayment.model.js';
import ExpenseSettings from './expenseSettings.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { ROLES } from '../../common/constants/index.js';
import { invalidate } from '../../realtime/socket.js';
import * as audit from '../audit/audit.service.js';
import { accountsByCode } from '../accounting/ledger.service.js';

export const FINANCE_ROLES = [ROLES.ADMIN, ROLES.ACCOUNTANT];
export const isFinance = (ctx) => FINANCE_ROLES.includes(ctx.role);
export const refresh = (societyId, keys) => invalidate(societyId, keys, { roles: [...FINANCE_ROLES, ROLES.FACILITY_MANAGER] });

const mask = (no) => (no ? `XXXX${String(no).slice(-4)}` : no);
// Lists never show full bank account numbers; only the finance team sees them on the detail view.
function present(ctx, v, { full = false } = {}) {
  const out = { ...v };
  if (out.bank?.accountNumber && !(full && isFinance(ctx))) out.bank = { ...out.bank, accountNumber: mask(out.bank.accountNumber) };
  if (!isFinance(ctx)) delete out.notes;
  return out;
}

export async function loadVendor(ctx, id, { activeOnly = false } = {}) {
  const vendor = await Vendor.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!vendor) throw ApiError.notFound('Vendor not found');
  if (activeOnly && !vendor.active) throw ApiError.badRequest(`${vendor.name} is inactive`);
  return vendor;
}

// Bill lines and vendor defaults must point at an active expense (or non-cash asset) account.
export async function assertExpenseAccounts(ctx, codes) {
  const accounts = await accountsByCode(ctx.societyId);
  for (const code of new Set(codes)) {
    const a = accounts.get(code);
    if (!a) throw ApiError.badRequest(`Unknown account ${code}`);
    if (!a.active) throw ApiError.badRequest(`Account ${code} ${a.name} is inactive`);
    if (!(a.type === 'expense' || (a.type === 'asset' && !a.isBank && !a.isCash && a.code !== '1100'))) {
      throw ApiError.badRequest(`${code} ${a.name} is not an expense account`);
    }
  }
  return accounts;
}

export async function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.category) filter.category = filters.category;
  if (filters.active !== undefined) filter.active = filters.active;
  if (filters.search) {
    const rx = new RegExp(escapeRegex(filters.search), 'i');
    filter.$or = [{ name: rx }, { contactPerson: rx }, { phone: rx }, { gstin: rx }, { email: rx }];
  }
  const result = await paginate(Vendor, filter, pagination, { sort: { active: -1, name: 1 } });
  if (isFinance(ctx) && result.items.length) {
    // outstanding per vendor for the list view
    const rows = await VendorBill.aggregate([
      { $match: { society: ctx.societyId, vendor: { $in: result.items.map((v) => v._id) }, status: { $in: ['unpaid', 'partial'] } } },
      { $group: { _id: '$vendor', outstanding: { $sum: { $subtract: ['$payable', '$paid'] } }, bills: { $sum: 1 } } },
    ]);
    const by = new Map(rows.map((r) => [String(r._id), r]));
    result.items = result.items.map((v) => ({ ...v, outstanding: by.get(String(v._id))?.outstanding || 0, openBills: by.get(String(v._id))?.bills || 0 }));
  }
  result.items = result.items.map((v) => present(ctx, v));
  return result;
}

export async function getById(ctx, id) {
  return present(ctx, await loadVendor(ctx, id), { full: true });
}

export async function create(ctx, data) {
  if (data.defaultAccount) await assertExpenseAccounts(ctx, [data.defaultAccount]);
  if (await Vendor.exists({ society: ctx.societyId, name: new RegExp(`^${escapeRegex(data.name)}$`, 'i') })) {
    throw ApiError.conflict(`A vendor named "${data.name}" already exists`);
  }
  const vendor = await Vendor.create({ ...data, society: ctx.societyId, createdBy: ctx.userId });
  audit.record(ctx, 'vendor.created', 'Vendor', vendor._id, { name: vendor.name });
  refresh(ctx.societyId, ['vendors']);
  return present(ctx, vendor.toObject(), { full: true });
}

export async function update(ctx, id, data) {
  const vendor = await Vendor.findOne({ _id: id, society: ctx.societyId });
  if (!vendor) throw ApiError.notFound('Vendor not found');
  if (data.defaultAccount) await assertExpenseAccounts(ctx, [data.defaultAccount]);
  if (data.name && data.name.toLowerCase() !== vendor.name.toLowerCase()
    && (await Vendor.exists({ society: ctx.societyId, _id: { $ne: vendor._id }, name: new RegExp(`^${escapeRegex(data.name)}$`, 'i') }))) {
    throw ApiError.conflict(`A vendor named "${data.name}" already exists`);
  }
  vendor.set(data);
  await vendor.save();
  audit.record(ctx, 'vendor.updated', 'Vendor', vendor._id, { name: vendor.name, changes: Object.keys(data) });
  refresh(ctx.societyId, ['vendors']);
  return present(ctx, vendor.toObject(), { full: true });
}

/**
 * Vendor statement: bills raise what we owe (payable after TDS), payments reduce it.
 * Balance = amount still owed to the vendor.
 */
export async function statement(ctx, id, { from, to }) {
  const vendor = await loadVendor(ctx, id);
  const [bills, payments] = await Promise.all([
    VendorBill.find({ society: ctx.societyId, vendor: vendor._id, status: { $ne: 'cancelled' } }).select('number billNo billDate dueDate payable paid status total tdsAmount').lean(),
    VendorPayment.find({ society: ctx.societyId, vendor: vendor._id, status: 'posted' }).select('number date amount method reference').lean(),
  ]);
  const events = [
    ...bills.map((b) => ({ date: b.billDate, type: 'bill', id: b._id, number: b.number, ref: b.billNo, description: `Invoice ${b.billNo}${b.tdsAmount ? ' (net of TDS)' : ''}`, billed: b.payable, paid: 0 })),
    ...payments.map((p) => ({ date: p.date, type: 'payment', id: p._id, number: p.number, ref: p.reference, description: `Payment (${p.method})`, billed: 0, paid: p.amount })),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'bill' ? -1 : 1));

  let opening = 0;
  let balance = 0;
  const rows = [];
  for (const e of events) {
    if (from && e.date < from) {
      opening += e.billed - e.paid;
      balance = opening;
      continue;
    }
    if (to && e.date > to) continue;
    balance += e.billed - e.paid;
    rows.push({ ...e, balance });
  }
  const openBills = bills.filter((b) => ['unpaid', 'partial'].includes(b.status)).map((b) => ({ ...b, balance: b.payable - b.paid })).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return {
    vendor: present(ctx, vendor),
    from: from || null,
    to: to || null,
    opening,
    billed: rows.reduce((s, r) => s + r.billed, 0),
    paid: rows.reduce((s, r) => s + r.paid, 0),
    closing: balance,
    outstanding: openBills.reduce((s, b) => s + b.balance, 0),
    rows,
    openBills,
  };
}

// ---------- settings ----------

export async function getSettings(ctx) {
  const s = await ExpenseSettings.findOne({ society: ctx.societyId }).lean();
  return { autoApproveLimit: s?.autoApproveLimit ?? 0, defaultDueDays: s?.defaultDueDays ?? 15 };
}

export async function updateSettings(ctx, data) {
  const s = await ExpenseSettings.findOneAndUpdate(
    { society: ctx.societyId },
    { $set: { ...data, updatedBy: ctx.userId }, $setOnInsert: { society: ctx.societyId } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  audit.record(ctx, 'expenses.settings_updated', 'ExpenseSettings', s._id, data);
  return { autoApproveLimit: s.autoApproveLimit, defaultDueDays: s.defaultDueDays };
}
