import Bill from './bill.model.js';

// Atomic single-document updates on a bill. Each one checks its precondition in the filter, so two
// concurrent requests can never over-pay, over-waive or over-reverse a bill. They return the updated
// bill, or null when the precondition no longer holds.

export const OPEN = ['unpaid', 'partial'];

// paid ≥ total → paid; some money in → partial; nothing → unpaid.
const recomputeStatus = {
  $set: { status: { $cond: [{ $gte: ['$paid', '$total'] }, 'paid', { $cond: [{ $gt: ['$paid', 0] }, 'partial', 'unpaid'] }] } },
};
const opts = (session) => ({ returnDocument: 'after', updatePipeline: true, session });

// Adds money to an open bill, refusing overpayment. `fromCredit` marks it as advance credit applied.
export function addPaid(societyId, billId, amount, { fromCredit = false, session } = {}) {
  const inc = { paid: { $add: ['$paid', amount] } };
  if (fromCredit) inc.creditApplied = { $add: [{ $ifNull: ['$creditApplied', 0] }, amount] };
  return Bill.findOneAndUpdate(
    { _id: billId, society: societyId, status: { $in: OPEN }, $expr: { $gte: [{ $subtract: ['$total', '$paid'] }, amount] } },
    [{ $set: inc }, recomputeStatus],
    opts(session),
  ).lean();
}

// Takes a previously applied (now bounced) payment back off a bill.
export function reversePaid(societyId, billId, amount, { session } = {}) {
  return Bill.findOneAndUpdate(
    { _id: billId, society: societyId, status: { $in: ['paid', 'partial'] }, paid: { $gte: amount } },
    [{ $set: { paid: { $subtract: ['$paid', amount] } } }, recomputeStatus],
    opts(session),
  ).lean();
}

// Lowers an open bill's total by an approved waiver (never below what is already paid).
export function addWaiver(societyId, billId, amount, { session } = {}) {
  return Bill.findOneAndUpdate(
    { _id: billId, society: societyId, status: { $in: OPEN }, $expr: { $gte: [{ $subtract: ['$total', '$paid'] }, amount] } },
    [{ $set: { waived: { $add: [{ $ifNull: ['$waived', 0] }, amount] }, total: { $subtract: ['$total', amount] } } }, recomputeStatus],
    opts(session),
  ).lean();
}
