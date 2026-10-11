// Demo data for accounting & expenses: vendors, a few vendor bills and payments, a recurring contract,
// purchase requests, this year's budget, and the ledger synced from the demo bills.
import { localDateString, localPeriod } from '../../src/common/utils/dates.js';
import { ensureChart } from '../../src/modules/accounting/ledger.service.js';
import { syncSociety } from '../../src/modules/accounting/sync.service.js';
import { saveBudget } from '../../src/modules/accounting/budget.service.js';
import { fyOf } from '../../src/modules/accounting/chart.js';
import * as vendors from '../../src/modules/expenses/vendors.service.js';
import * as prs from '../../src/modules/expenses/purchaseRequests.service.js';
import * as payables from '../../src/modules/expenses/payables.service.js';

const rupees = (n) => Math.round(n * 100);

export default async function seed(s) {
  await ensureChart(s.sid);
  const accountant = await s.user('accountant@demo.test');
  const manager = await s.user('manager@demo.test');
  const accCtx = { ...s.ctx, userId: accountant?._id || s.ctx.userId, role: accountant ? 'accountant' : 'admin' };
  const fmCtx = manager ? { ...s.ctx, userId: manager._id, role: 'facility_manager' } : null;
  const today = localDateString();
  const monthStart = `${localPeriod()}-01`;
  const daysAgo = (n) => payables.addDaysIso(today, -n);

  await vendors.updateSettings(s.ctx, { autoApproveLimit: rupees(2000), defaultDueDays: 15 });

  const shield = await vendors.create(accCtx, {
    name: 'Shield Security Services', category: 'security', contactPerson: 'Vikram Singh', phone: '9810000011', email: 'accounts@shieldsecurity.test',
    gstin: '27AAKCS1234F1Z5', pan: 'AAKCS1234F', address: 'Baner, Pune', defaultAccount: '5100', tdsSection: '194C', tdsRate: 2,
    bank: { accountName: 'Shield Security Services', accountNumber: '50200012345678', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' },
  });
  const clean = await vendors.create(accCtx, {
    name: 'CleanCo Facility Services', category: 'housekeeping', contactPerson: 'Rekha Pawar', phone: '9810000012', defaultAccount: '5200', tdsSection: '194C', tdsRate: 1,
  });
  const otis = await vendors.create(accCtx, {
    name: 'Otis Elevator Co.', category: 'amc', phone: '9810000013', gstin: '27AAACO1234K1Z2', defaultAccount: '5600', tdsSection: '194C', tdsRate: 2,
  });
  const mseb = await vendors.create(accCtx, { name: 'MSEDCL (common electricity)', category: 'utilities', defaultAccount: '5400' });

  // last month's security bill, paid in full; this month's housekeeping bill, partly paid
  const securityBill = await payables.createBill(accCtx, {
    vendor: shield._id, billNo: 'SSS/24-25/0912', billDate: daysAgo(35), dueDate: daysAgo(20),
    lines: [{ description: 'Security guards (4 x 12h shifts)', account: '5100', amount: rupees(84000) }], gstAmount: rupees(15120),
  });
  await payables.createPayment(accCtx, {
    vendor: shield._id, date: daysAgo(18), amount: securityBill.payable, method: 'bank', reference: 'NEFT00412345',
    allocations: [{ bill: securityBill._id, amount: securityBill.payable }],
  });
  const cleanBill = await payables.createBill(accCtx, {
    vendor: clean._id, billNo: 'CC-1043', billDate: daysAgo(8),
    lines: [{ description: 'Housekeeping staff (6)', account: '5200', amount: rupees(54000) }, { description: 'Cleaning supplies', account: '5200', amount: rupees(6500) }],
  });
  await payables.createPayment(accCtx, {
    vendor: clean._id, date: daysAgo(2), amount: rupees(30000), method: 'upi', reference: 'UPI615243789012',
    allocations: [{ bill: cleanBill._id, amount: rupees(30000) }],
  });
  await payables.createBill(accCtx, {
    vendor: otis._id, billNo: 'OTIS/Q3/7781', billDate: daysAgo(70), dueDate: daysAgo(40),
    lines: [{ description: 'Lift AMC, quarter 3 (2 lifts)', account: '5600', amount: rupees(36000) }], gstAmount: rupees(6480),
  });
  await payables.createBill(accCtx, {
    vendor: mseb._id, billNo: `CEB-${localPeriod()}`, billDate: monthStart, dueDate: payables.addDaysIso(today, 2), tdsRate: 0,
    lines: [{ description: 'Common area electricity', account: '5400', amount: rupees(18450) }],
  });

  await payables.createRecurring(accCtx, {
    name: 'Security agency monthly bill', vendor: shield._id, dayOfMonth: 1, dueDays: 15, startDate: `${payables.addDaysIso(monthStart, 31).slice(0, 7)}-01`,
    lines: [{ description: 'Security guards (4 x 12h shifts)', account: '5100', amount: rupees(84000) }], gstAmount: rupees(15120),
  });

  if (fmCtx) {
    await prs.create(fmCtx, {
      title: 'Replace basement water pump', submit: true,
      justification: 'The 5 HP pump in the basement trips daily; the repairer says the winding is burnt.',
      items: [{ description: '5 HP submersible pump', quantity: 1, rate: rupees(38500) }, { description: 'Installation', quantity: 1, rate: rupees(4500) }],
    });
    await prs.create(fmCtx, { title: 'Garbage bags for the month', amount: rupees(1800), submit: true }); // auto-approved (under ₹2,000)
  }

  const fy = fyOf(today);
  await saveBudget(accCtx, fy, {
    lines: [
      { code: '4000', amount: rupees(4200000) },
      { code: '4200', amount: rupees(120000) },
      { code: '5100', amount: rupees(1190000) },
      { code: '5200', amount: rupees(730000) },
      { code: '5300', amount: rupees(300000) },
      { code: '5400', amount: rupees(240000) },
      { code: '5600', amount: rupees(170000) },
      { code: '5700', amount: rupees(60000) },
    ],
  });

  // Opening bank balance and funds at the start of the year, then post the demo bills/payments.
  const { postOpeningBalances } = await import('../../src/modules/accounting/accounting.service.js');
  await postOpeningBalances(accCtx, {
    date: `${fy}-04-01`,
    lines: [{ code: '1000', debit: rupees(1250000) }, { code: '1010', debit: rupees(15000) }, { code: '3100', credit: rupees(800000) }, { code: '3200', credit: rupees(150000) }],
  });
  await syncSociety(accCtx, { full: true });
}
