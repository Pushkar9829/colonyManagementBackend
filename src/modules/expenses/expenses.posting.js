// Journal postings for vendor bills and payments. Called by the expenses service when documents are
// created/cancelled, and by the accounting sync as a safety net (all calls are idempotent).
import { postEntry, reverseEntry } from '../accounting/ledger.service.js';
import { CODES } from '../accounting/chart.js';
import { localDateString } from '../../common/utils/dates.js';

/*
 * Vendor bill:
 *   Dr expense account of each line        line amount
 *   Dr 1150 Other receivables (GST input)  GST, when the society claims input credit
 *      — otherwise GST is part of the cost and is debited to the first line's expense account
 *   Cr 2000 Vendor payables                total (subtotal + GST)
 *   Dr 2000 / Cr 2200 TDS payable          TDS withheld (reduces what we owe the vendor)
 */
export function vendorBillLines(bill) {
  const vendor = bill.vendor?._id || bill.vendor;
  const lines = bill.lines.map((l) => ({ accountCode: l.account, debit: l.amount, vendor, memo: l.description }));
  if (bill.gstAmount > 0) {
    lines.push({ accountCode: bill.claimGst ? CODES.OTHER_RECEIVABLES : bill.lines[0].account, debit: bill.gstAmount, vendor, memo: 'GST' });
  }
  lines.push({ accountCode: CODES.VENDOR_PAYABLES, credit: bill.total, vendor });
  if (bill.tdsAmount > 0) {
    lines.push({ accountCode: CODES.VENDOR_PAYABLES, debit: bill.tdsAmount, vendor, memo: `TDS ${bill.tdsSection || ''}`.trim() });
    lines.push({ accountCode: CODES.TDS_PAYABLE, credit: bill.tdsAmount, vendor, memo: `TDS ${bill.tdsSection || ''}`.trim() });
  }
  return lines;
}

export function postVendorBill(ctx, bill, vendorName = '') {
  return postEntry(ctx, {
    date: bill.billDate,
    narration: `Vendor bill ${bill.number}${vendorName ? ` · ${vendorName}` : ''} (invoice ${bill.billNo})`,
    reference: bill.billNo,
    sourceType: 'vendor_bill',
    sourceId: String(bill._id),
    lines: vendorBillLines(bill),
  });
}

export const reverseVendorBill = (ctx, bill, reason, date = localDateString()) =>
  reverseEntry(ctx, 'vendor_bill', String(bill._id), reason || 'Vendor bill cancelled', date);

// Vendor payment: Dr 2000 Vendor payables, Cr the bank / cash account it was paid from.
export function postVendorPayment(ctx, payment, vendorName = '') {
  const vendor = payment.vendor?._id || payment.vendor;
  return postEntry(ctx, {
    date: payment.date,
    narration: `Vendor payment ${payment.number}${vendorName ? ` · ${vendorName}` : ''}`,
    reference: payment.reference,
    sourceType: 'vendor_payment',
    sourceId: String(payment._id),
    lines: [
      { accountCode: CODES.VENDOR_PAYABLES, debit: payment.amount, vendor },
      { accountCode: payment.account, credit: payment.amount, vendor },
    ],
  });
}

export const reverseVendorPayment = (ctx, payment, reason, date = localDateString()) =>
  reverseEntry(ctx, 'vendor_payment', String(payment._id), reason || 'Vendor payment cancelled', date);
