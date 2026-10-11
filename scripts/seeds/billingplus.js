// Demo data for finance extras: finance settings, water meters with readings and a tariff, an advance
// payment, an opening balance, a cheque payment and a waiver waiting for the admin.
import Bill from '../../src/modules/billing/bill.model.js';
import * as financeSettings from '../../src/modules/financeSettings/financeSettings.service.js';
import * as meters from '../../src/modules/meters/meters.service.js';
import * as adjustments from '../../src/modules/billing/adjustments.service.js';
import * as payments from '../../src/modules/payments/payments.service.js';
import { localPeriod } from '../../src/common/utils/dates.js';

const rupees = (n) => Math.round(n * 100);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

export default async function seed(s) {
  const accountant = await s.user('accountant@demo.test');
  const manager = await s.user('manager@demo.test');
  const accCtx = { ...s.ctx, userId: accountant?._id || s.ctx.userId, role: accountant ? 'accountant' : 'admin' };
  const fmCtx = { ...s.ctx, userId: manager?._id || s.ctx.userId, role: manager ? 'facility_manager' : 'admin' };

  await financeSettings.update(s.ctx, {
    gstin: '27AABAG1234C1Z9',
    chequeBounceCharge: rupees(500),
    nonOccupancy: { percent: 10, appliesTo: ['rented'] },
    waiverApprovalRequired: true,
    autopayEnabled: true,
    headGst: [{ head: 'Sinking fund', rate: 0 }, { head: 'Water', rate: 0 }],
  });

  await meters.createTariff(accCtx, {
    type: 'water',
    name: 'Water 2026-27',
    slabs: [{ upTo: 10, rate: rupees(20) }, { upTo: 25, rate: rupees(35) }, { upTo: null, rate: rupees(60) }],
    fixedCharge: rupees(50),
  });

  // Water meters on the first floor of block A with two readings each (last month and this month).
  const start = [1240, 980, 1505, 760];
  for (const [i, label] of ['A-101', 'A-102', 'A-103', 'A-104'].entries()) {
    // eslint-disable-next-line no-await-in-loop
    const unit = await s.unit(label);
    if (!unit) continue;
    // eslint-disable-next-line no-await-in-loop
    const meter = await meters.createMeter(fmCtx, { unit: unit._id, type: 'water', serial: `WM-${label}`, initialReading: start[i], installedAt: daysAgo(90) });
    // eslint-disable-next-line no-await-in-loop
    await meters.addReading(fmCtx, meter._id, { reading: start[i] + 9 + i * 3, readAt: daysAgo(35) });
    // eslint-disable-next-line no-await-in-loop
    await meters.addReading(fmCtx, meter._id, { reading: start[i] + 21 + i * 5, readAt: daysAgo(3), source: 'device' });
  }

  // Vikram (A-201) paid a quarter in advance; it will be adjusted on the next bills.
  const a201 = await s.unit('A-201');
  if (a201) await payments.recordAdvance(accCtx, { unit: a201._id, amount: rupees(12000), method: 'bank', reference: 'UTR4471239901' });

  // Dues brought forward from the old system for B-204.
  await adjustments.importOpeningBalances(accCtx, [{ unit: 'B-204', amount: rupees(8350), asOf: `${localPeriod(daysAgo(60))}-01` }]);

  // Neha (A-102) paid by cheque; the accountant asked for a small waiver on Anita's bill.
  const period = localPeriod();
  const a102 = await s.unit('A-102');
  const neha = a102 && (await Bill.findOne({ society: s.sid, unit: a102._id, period }).lean());
  if (neha) await payments.recordOffline(accCtx, { bill: neha._id, amount: neha.total - neha.paid, method: 'cheque', reference: '104455' });
  const b101 = await s.unit('B-101');
  const anita = b101 && (await Bill.findOne({ society: s.sid, unit: b101._id, period }).lean());
  if (anita) await adjustments.requestWaiver(accCtx, { bill: anita._id, amount: rupees(250), reason: 'Lift was out of order for 10 days' });
}
