// Vendor bills, vendor payments and recurring expense templates.
import mongoose from 'mongoose';
import VendorBill, { billBalance } from './vendorBill.model.js';
import VendorPayment from './vendorPayment.model.js';
import Vendor from './vendor.model.js';
import RecurringExpense from './recurringExpense.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import logger from '../../common/utils/logger.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { localDateString, localPeriod } from '../../common/utils/dates.js';
import { money } from '../../common/utils/money.js';
import { ROLES } from '../../common/constants/index.js';
import { nextNumber } from '../counter/counter.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { accountsByCode } from '../accounting/ledger.service.js';
import { CODES } from '../accounting/chart.js';
import { OPEN_BILL } from './constants.js';
import { postVendorBill, postVendorPayment, reverseVendorBill, reverseVendorPayment } from './expenses.posting.js';
import { assertExpenseAccounts, getSettings, loadVendor, refresh } from './vendors.service.js';
import { claimForBill, markConverted, releaseFromBill } from './purchaseRequests.service.js';

const BILL_POPULATE = [
  { path: 'vendor', select: 'name category gstin' },
  { path: 'purchaseRequest', select: 'number title' },
  { path: 'createdBy', select: 'name' },
];
const PAYMENT_POPULATE = [
  { path: 'vendor', select: 'name' },
  { path: 'allocations.bill', select: 'number billNo billDate payable' },
  { path: 'createdBy', select: 'name' },
];

export function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const withBalance = (b) => ({ ...b, balance: billBalance(b) });
const changed = (ctx) => refresh(ctx.societyId, ['vendorBills', 'vendorPayments', 'vendors', 'accounting']);

// ---------- vendor bills ----------

export function computeBill({ lines, gstAmount = 0, tdsRate = 0 }) {
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  if (subtotal <= 0) throw ApiError.badRequest('Bill amount must be more than zero');
  // TDS is deducted on the value before GST when GST is shown separately on the invoice.
  const tdsAmount = Math.round((subtotal * (tdsRate || 0)) / 100);
  const total = subtotal + (gstAmount || 0);
  return { subtotal, gstAmount: gstAmount || 0, tdsRate: tdsRate || 0, tdsAmount, total, payable: total - tdsAmount };
}

async function insertBill(ctx, data, { vendor, recurring, recurringPeriod, skipPrCheck = false } = {}) {
  await assertExpenseAccounts(ctx, data.lines.map((l) => l.account));
  if (data.purchaseRequest && !skipPrCheck) await claimForBill(ctx, data.purchaseRequest, vendor._id);
  const settings = await getSettings(ctx);
  const tdsRate = data.tdsRate ?? vendor.tdsRate ?? 0;
  const amounts = computeBill({ lines: data.lines, gstAmount: data.gstAmount, tdsRate });
  const billDate = data.billDate || localDateString();
  const dueDate = data.dueDate || addDaysIso(billDate, settings.defaultDueDays);
  if (dueDate < billDate) throw ApiError.badRequest('Due date cannot be before the bill date');
  const attachments = await uploads.resolve(ctx, data.attachments);

  let bill;
  try {
    bill = await VendorBill.create({
      society: ctx.societyId,
      number: await nextNumber(ctx.societyId, 'vendor_bill', 'VB'),
      vendor: vendor._id,
      billNo: data.billNo,
      billDate,
      dueDate,
      lines: data.lines,
      ...amounts,
      claimGst: Boolean(data.claimGst),
      tdsSection: amounts.tdsAmount ? data.tdsSection || vendor.tdsSection : undefined,
      attachments,
      purchaseRequest: data.purchaseRequest,
      recurring,
      recurringPeriod,
      notes: data.notes,
      createdBy: ctx.userId || undefined,
    });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.billNo) throw ApiError.conflict('Invoice {billNo} from {vendor} is already recorded', { params: { billNo: data.billNo, vendor: vendor.name } });
    throw err;
  }
  try {
    await postVendorBill(ctx, bill.toObject(), vendor.name);
    if (data.purchaseRequest) await markConverted(ctx, data.purchaseRequest, bill._id, ctx.userId);
  } catch (err) {
    // keep documents and ledger consistent: a bill that cannot be posted is not kept
    await reverseVendorBill(ctx, bill, 'Bill creation failed').catch(() => {});
    await bill.deleteOne();
    throw err;
  }
  audit.record(ctx, 'vendor_bill.created', 'VendorBill', bill._id, { number: bill.number, vendor: vendor.name, total: bill.total, tds: bill.tdsAmount });
  changed(ctx);
  return bill;
}

export async function createBill(ctx, data) {
  const vendor = await loadVendor(ctx, data.vendor, { activeOnly: true });
  const bill = await insertBill(ctx, data, { vendor });
  return getBill(ctx, bill._id);
}

export async function listBills(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.vendor) filter.vendor = filters.vendor;
  if (filters.status) filter.status = filters.status;
  if (filters.open) filter.status = { $in: OPEN_BILL };
  if (filters.overdue) {
    filter.status = { $in: OPEN_BILL };
    filter.dueDate = { $lt: localDateString() };
  }
  if (filters.from || filters.to) filter.billDate = { ...(filters.from && { $gte: filters.from }), ...(filters.to && { $lte: filters.to }) };
  if (filters.search) {
    const rx = new RegExp(escapeRegex(filters.search), 'i');
    filter.$or = [{ billNo: rx }, { number: rx }];
  }
  const result = await paginate(VendorBill, filter, pagination, { sort: { billDate: -1, number: -1 }, populate: BILL_POPULATE.slice(0, 1), select: '-attachments' });
  result.items = result.items.map(withBalance);
  return result;
}

export async function getBill(ctx, id) {
  const bill = await VendorBill.findOne({ _id: id, society: ctx.societyId }).populate(BILL_POPULATE).lean();
  if (!bill) throw ApiError.notFound('Vendor bill not found');
  const payments = await VendorPayment.find({ society: ctx.societyId, 'allocations.bill': bill._id }).sort({ date: 1 }).lean();
  return {
    ...withBalance(bill),
    payments: payments.map((p) => ({
      _id: p._id, number: p.number, date: p.date, method: p.method, reference: p.reference, status: p.status,
      amount: p.allocations.find((a) => String(a.bill) === String(bill._id))?.amount || 0,
    })),
  };
}

export async function cancelBill(ctx, id, { reason }) {
  const bill = await VendorBill.findOne({ _id: id, society: ctx.societyId });
  if (!bill) throw ApiError.notFound('Vendor bill not found');
  if (bill.status === 'cancelled') throw ApiError.conflict('Bill is already cancelled');
  if (bill.paid > 0) throw ApiError.conflict('Cancel the payments against this bill first');
  const updated = await VendorBill.findOneAndUpdate(
    { _id: bill._id, society: ctx.societyId, paid: 0, status: { $ne: 'cancelled' } },
    { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw ApiError.conflict('Bill changed while cancelling; try again');
  await reverseVendorBill(ctx, updated, reason ? `Cancelled: ${reason}` : 'Vendor bill cancelled');
  if (updated.purchaseRequest) await releaseFromBill(ctx, updated.purchaseRequest, ctx.userId);
  audit.record(ctx, 'vendor_bill.cancelled', 'VendorBill', bill._id, { number: bill.number, reason });
  changed(ctx);
  return getBill(ctx, bill._id);
}

// ---------- vendor payments ----------

// Adds (or with a negative amount removes) money against a bill, refusing to overpay. Status follows paid.
function applyToBill(societyId, billId, vendorId, amount) {
  const guard = amount > 0
    ? { status: { $in: OPEN_BILL }, $expr: { $gte: [{ $subtract: ['$payable', '$paid'] }, amount] } }
    : { $expr: { $gte: ['$paid', -amount] } };
  return VendorBill.findOneAndUpdate(
    { _id: billId, society: societyId, vendor: vendorId, ...guard },
    [
      { $set: { paid: { $add: ['$paid', amount] } } },
      { $set: { status: { $cond: [{ $eq: ['$status', 'cancelled'] }, 'cancelled', { $cond: [{ $gte: ['$paid', '$payable'] }, 'paid', { $cond: [{ $gt: ['$paid', 0] }, 'partial', 'unpaid'] }] }] } } },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).lean();
}

async function paymentAccount(ctx, method, code) {
  const accounts = await accountsByCode(ctx.societyId);
  const chosen = code || (method === 'cash' ? CODES.CASH : CODES.BANK);
  const a = accounts.get(chosen);
  if (!a || !(a.isBank || a.isCash)) throw ApiError.badRequest('{account} is not a bank or cash account', { params: { account: chosen } });
  if (!a.active) throw ApiError.badRequest('{name} is inactive', { params: { name: a.name } });
  return a;
}

export async function createPayment(ctx, data) {
  const vendor = await loadVendor(ctx, data.vendor);
  const account = await paymentAccount(ctx, data.method, data.account);
  const allocations = Object.values(
    data.allocations.reduce((m, a) => {
      const k = String(a.bill);
      m[k] = { bill: k, amount: (m[k]?.amount || 0) + a.amount };
      return m;
    }, {}),
  );
  const allocated = allocations.reduce((s, a) => s + a.amount, 0);
  if (allocated !== data.amount) throw ApiError.badRequest('Allocations ({allocated}) must add up to the payment amount ({amount})', { params: { allocated: money(allocated), amount: money(data.amount) } });

  const bills = await VendorBill.find({ society: ctx.societyId, _id: { $in: allocations.map((a) => a.bill) } }).lean();
  if (bills.length !== allocations.length) throw ApiError.badRequest('One or more bills were not found');
  for (const a of allocations) {
    const b = bills.find((x) => String(x._id) === a.bill);
    if (String(b.vendor) !== String(vendor._id)) throw ApiError.badRequest('{number} belongs to a different vendor', { params: { number: b.number } });
    if (!OPEN_BILL.includes(b.status)) throw ApiError.conflict('{number} is {status}', { params: { number: b.number, status: b.status } });
    if (a.amount > b.payable - b.paid) throw ApiError.badRequest('{amount} is more than the {due} due on {number}', { params: { amount: money(a.amount), due: money(b.payable - b.paid), number: b.number } });
  }

  // Apply bill by bill; undo what was applied if any bill refuses (concurrent payment).
  const applied = [];
  const undo = () => Promise.all(applied.map((a) => applyToBill(ctx.societyId, a.bill, vendor._id, -a.amount)));
  for (const a of allocations) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await applyToBill(ctx.societyId, a.bill, vendor._id, a.amount);
    if (!ok) {
      // eslint-disable-next-line no-await-in-loop
      await undo();
      throw ApiError.conflict('A bill was paid meanwhile; reload and try again');
    }
    applied.push(a);
  }

  let payment;
  try {
    payment = await VendorPayment.create({
      society: ctx.societyId,
      number: await nextNumber(ctx.societyId, 'vendor_payment', 'VP'),
      vendor: vendor._id,
      date: data.date || localDateString(),
      amount: data.amount,
      method: data.method,
      reference: data.reference,
      account: account.code,
      allocations,
      notes: data.notes,
      createdBy: ctx.userId,
    });
    await postVendorPayment(ctx, payment.toObject(), vendor.name);
  } catch (err) {
    await undo();
    if (payment) {
      await reverseVendorPayment(ctx, payment, 'Payment creation failed').catch(() => {});
      await payment.deleteOne();
    }
    throw err;
  }
  audit.record(ctx, 'vendor_payment.created', 'VendorPayment', payment._id, { number: payment.number, vendor: vendor.name, amount: payment.amount, method: payment.method });
  changed(ctx);
  return getPayment(ctx, payment._id);
}

export async function listPayments(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.vendor) filter.vendor = filters.vendor;
  if (filters.method) filter.method = filters.method;
  if (filters.status) filter.status = filters.status;
  if (filters.from || filters.to) filter.date = { ...(filters.from && { $gte: filters.from }), ...(filters.to && { $lte: filters.to }) };
  if (filters.search) {
    const rx = new RegExp(escapeRegex(filters.search), 'i');
    filter.$or = [{ number: rx }, { reference: rx }];
  }
  return paginate(VendorPayment, filter, pagination, { sort: { date: -1, number: -1 }, populate: PAYMENT_POPULATE });
}

export async function getPayment(ctx, id) {
  const p = await VendorPayment.findOne({ _id: id, society: ctx.societyId }).populate(PAYMENT_POPULATE).lean();
  if (!p) throw ApiError.notFound('Vendor payment not found');
  return p;
}

export async function cancelPayment(ctx, id, { reason }) {
  const payment = await VendorPayment.findOneAndUpdate(
    { _id: id, society: ctx.societyId, status: 'posted' },
    { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason },
    { returnDocument: 'after' },
  ).lean();
  if (!payment) {
    if (await VendorPayment.exists({ _id: id, society: ctx.societyId })) throw ApiError.conflict('Payment is already cancelled');
    throw ApiError.notFound('Vendor payment not found');
  }
  for (const a of payment.allocations) {
    // eslint-disable-next-line no-await-in-loop
    await applyToBill(ctx.societyId, a.bill, payment.vendor, -a.amount);
  }
  await reverseVendorPayment(ctx, payment, reason ? `Cancelled: ${reason}` : 'Vendor payment cancelled');
  audit.record(ctx, 'vendor_payment.cancelled', 'VendorPayment', payment._id, { number: payment.number, reason });
  changed(ctx);
  return getPayment(ctx, payment._id);
}

// ---------- recurring expenses ----------

export async function listRecurring(ctx, filters = {}) {
  const filter = { society: ctx.societyId };
  if (filters.active !== undefined) filter.active = filters.active;
  return RecurringExpense.find(filter).sort({ active: -1, name: 1 }).populate([{ path: 'vendor', select: 'name' }, { path: 'lastBill', select: 'number billDate total' }]).lean();
}

export async function createRecurring(ctx, data) {
  await loadVendor(ctx, data.vendor, { activeOnly: true });
  await assertExpenseAccounts(ctx, data.lines.map((l) => l.account));
  if (data.endDate && data.endDate < data.startDate) throw ApiError.badRequest('End date is before the start date');
  const doc = await RecurringExpense.create({ ...data, society: ctx.societyId, createdBy: ctx.userId });
  audit.record(ctx, 'recurring_expense.created', 'RecurringExpense', doc._id, { name: doc.name });
  refresh(ctx.societyId, ['recurringExpenses']);
  return RecurringExpense.findById(doc._id).populate('vendor', 'name').lean();
}

export async function updateRecurring(ctx, id, data) {
  const doc = await RecurringExpense.findOne({ _id: id, society: ctx.societyId });
  if (!doc) throw ApiError.notFound('Recurring expense not found');
  if (data.vendor) await loadVendor(ctx, data.vendor, { activeOnly: true });
  if (data.lines) await assertExpenseAccounts(ctx, data.lines.map((l) => l.account));
  doc.set(data);
  if (doc.endDate && doc.endDate < doc.startDate) throw ApiError.badRequest('End date is before the start date');
  await doc.save();
  audit.record(ctx, 'recurring_expense.updated', 'RecurringExpense', doc._id, { name: doc.name, changes: Object.keys(data) });
  refresh(ctx.societyId, ['recurringExpenses']);
  return RecurringExpense.findById(doc._id).populate('vendor', 'name').lean();
}

// Creates the template's bill for `period` (YYYY-MM) once; returns the bill or null if it already exists.
async function generateFor(ctx, template, period) {
  const vendor = await Vendor.findOne({ _id: template.vendor, society: ctx.societyId }).lean();
  if (!vendor?.active) throw ApiError.badRequest('The vendor of this template is inactive');
  if (await VendorBill.exists({ society: ctx.societyId, recurring: template._id, recurringPeriod: period })) return null;
  const billDate = `${period}-${String(template.dayOfMonth).padStart(2, '0')}`;
  try {
    const bill = await insertBill(
      ctx,
      {
        billNo: `REC-${period}-${String(template._id).slice(-6).toUpperCase()}`,
        billDate,
        dueDate: addDaysIso(billDate, template.dueDays),
        lines: template.lines.map((l) => ({ description: l.description, account: l.account, amount: l.amount })),
        gstAmount: template.gstAmount,
        claimGst: template.claimGst,
        tdsRate: template.tdsRate ?? undefined,
        notes: `Recurring: ${template.name}`,
      },
      { vendor, recurring: template._id, recurringPeriod: period },
    );
    await RecurringExpense.updateOne({ _id: template._id }, { lastPeriod: period, lastBill: bill._id });
    return bill;
  } catch (err) {
    if (err.code === 11000 || err.status === 409) return null; // another instance generated it
    throw err;
  }
}

export async function runRecurringNow(ctx, id) {
  const template = await RecurringExpense.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!template) throw ApiError.notFound('Recurring expense not found');
  if (!template.active) throw ApiError.conflict('Template is paused');
  const period = localPeriod();
  const bill = await generateFor(ctx, template, period);
  if (!bill) throw ApiError.conflict('The bill for {period} already exists', { params: { period } });
  return getBill(ctx, bill._id);
}

const systemCtx = (societyId) => ({ societyId, userId: null, role: ROLES.ADMIN, unitId: null, ip: 'scheduler' });

// Scheduled: raises this month's bill for every active template whose day has come.
export async function generateRecurringBills(now = new Date()) {
  const today = localDateString(now);
  const period = localPeriod(now);
  const dayNum = Number(today.slice(8, 10));
  const due = await RecurringExpense.find({
    active: true,
    dayOfMonth: { $lte: dayNum },
    startDate: { $lte: today },
    $and: [
      { $or: [{ endDate: null }, { endDate: { $gte: today } }] },
      { $or: [{ lastPeriod: null }, { lastPeriod: { $lt: period } }] },
    ],
  }).limit(2000).lean();
  const societies = new Set((await Society.find({ _id: { $in: [...new Set(due.map((d) => String(d.society)))] }, active: true }).select('_id').lean()).map((s) => String(s._id)));
  let created = 0;
  let failed = 0;
  for (const t of due) {
    if (!societies.has(String(t.society))) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await generateFor(systemCtx(t.society), t, period)) created += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err: err.message, template: String(t._id) }, 'recurring vendor bill failed');
    }
  }
  return { created, failed };
}

// Scheduled: one heads-up per society to the accountants about vendor bills due within 3 days.
export async function vendorBillDueReminders(now = new Date()) {
  const today = localDateString(now);
  const soon = addDaysIso(today, 3);
  const bills = await VendorBill.find({ status: { $in: OPEN_BILL }, dueDate: { $gte: today, $lte: soon }, dueReminderAt: null })
    .select('society number dueDate payable paid vendor')
    .populate('vendor', 'name')
    .limit(5000)
    .lean();
  const bySociety = new Map();
  for (const b of bills) {
    const k = String(b.society);
    if (!bySociety.has(k)) bySociety.set(k, []);
    bySociety.get(k).push(b);
  }
  for (const [societyId, list] of bySociety) {
    const total = list.reduce((s, b) => s + b.payable - b.paid, 0);
    const first = list.sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    // eslint-disable-next-line no-await-in-loop
    await notifyRoles(new mongoose.Types.ObjectId(societyId), [ROLES.ACCOUNTANT], {
      type: 'vendor_bill',
      title: list.length === 1 ? `Vendor bill ${first.number} due on ${first.dueDate}` : `${list.length} vendor bills due in the next 3 days`,
      body: list.length === 1 ? `${first.vendor?.name || 'Vendor'} · ${money(total)}` : `${money(total)} in total · first due ${first.dueDate} (${daysBetween(today, first.dueDate)} days)`,
      link: '/expenses/bills?filter=open',
    });
  }
  if (bills.length) await VendorBill.updateMany({ _id: { $in: bills.map((b) => b._id) } }, { dueReminderAt: now });
  return { reminded: bills.length, societies: bySociety.size };
}
