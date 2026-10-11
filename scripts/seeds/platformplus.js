import crypto from 'node:crypto';
import User from '../../src/modules/users/user.model.js';
import Membership from '../../src/modules/users/membership.model.js';
import Unit from '../../src/modules/units/unit.model.js';
import PlatformInvoice from '../../src/modules/subscriptions/platformInvoice.model.js';
import Subscription from '../../src/modules/subscriptions/subscription.model.js';
import SubscriptionPayment from '../../src/modules/subscriptions/subscriptionPayment.model.js';
import { nextPlatformNumber } from '../../src/modules/subscriptions/platformCounter.model.js';
import { addLocalMonths, computeCharge, priceFor } from '../../src/modules/subscriptions/subscriptions.service.js';
import * as platform from '../../src/modules/platform/platform.service.js';
import * as features from '../../src/modules/features/features.service.js';
import * as support from '../../src/modules/support/support.service.js';
import * as reports from '../../src/modules/reports/reports.service.js';
import * as builder from '../../src/modules/builder/builder.service.js';
import { addDays, localDateString, localPeriod } from '../../src/common/utils/dates.js';

// Demo data for subscriptions, support, feature flags, scheduled reports and the builder module.
export default async function seed(s) {
  const owner = await User.findOne({ platformRole: 'super_admin' }).lean();
  const admin = await s.user('admin@demo.test');

  // Standard plan, monthly billing: last month paid, this month open.
  await platform.systemUpdateSociety(s.sid, { plan: { name: 'standard' } }, 'seed.plan');
  const price = await priceFor('standard');
  const units = await Unit.countDocuments({ society: s.sid });
  const thisMonth = new Date(`${localPeriod()}-01T00:00:00+05:30`);
  const lastMonth = addLocalMonths(thisMonth, -1);
  const charge = computeCharge({ units, price, cycle: 'monthly' });
  const invoices = [];
  for (const periodStart of [lastMonth, thisMonth]) {
    // eslint-disable-next-line no-await-in-loop
    invoices.push(await PlatformInvoice.create({
      society: s.sid,
      number: await nextPlatformNumber('platform_invoice', 'PINV'),
      plan: 'standard',
      billingCycle: 'monthly',
      periodStart,
      periodEnd: addLocalMonths(periodStart, 1),
      units,
      perUnitMonthly: price.perUnitMonthly,
      flatMonthly: price.flatMonthly,
      ...charge,
      dueDate: addDays(periodStart, 10),
      payToken: crypto.randomBytes(24).toString('base64url'),
    }));
  }
  const paid = invoices[0];
  const payment = await SubscriptionPayment.create({ society: s.sid, invoice: paid._id, amount: paid.total, method: 'bank', reference: 'NEFT-DEMO-0001', status: 'success', paidAt: addDays(paid.periodStart, 6), recordedBy: owner?._id });
  await PlatformInvoice.updateOne({ _id: paid._id }, { status: 'paid', paidAt: payment.paidAt, payment: payment._id });
  await Subscription.findOneAndUpdate(
    { society: s.sid },
    { billingCycle: 'monthly', billedUntil: invoices[1].periodEnd, paidUntil: paid.periodEnd, billingEmail: 'accounts@greenvalley.test', gstin: '27AABCG1234M1Z2' },
    { upsert: true },
  );
  await platform.systemUpdateSociety(s.sid, { validUntil: paid.periodEnd }, 'seed.paid_until');

  // Builder module switched on for the demo (not in the standard plan by default).
  if (owner) await features.setOverrides(owner, s.sid, { builder: true }, 'Demo project before handover');

  // Support: one answered ticket, one waiting for the platform.
  const ticket = await support.create(s.ctx, { category: 'billing', priority: 'medium', subject: 'Add GSTIN to our invoices', description: 'Please show our GSTIN 27AABCG1234M1Z2 on the platform invoices.' });
  if (owner) await support.platformReply(owner, ticket._id, { text: 'Done — you can also edit it yourself under Admin › Subscription & invoices.', status: 'resolved' });
  await support.create(s.ctx, { category: 'feature_request', priority: 'low', subject: 'Export visitors by block', description: 'Could the visitor report be filtered by block?' });

  await reports.createSchedule(s.ctx, { frequency: 'monthly', sections: ['collections', 'dues', 'complaints', 'visitors'], recipients: [] });

  // Builder staff: a society admin with the designation "Builder".
  const builderUser = await User.create({ name: 'Vikas Developers', email: 'builder@demo.test', phone: '9000000020', passwordHash: await User.hashPassword('Password@123') });
  const bm = await Membership.create({ user: builderUser._id, society: s.sid, role: 'admin', designation: 'Builder', status: 'active' });
  await User.updateOne({ _id: builderUser._id }, { lastMembership: bm._id });
  const bctx = { ...s.ctx, userId: builderUser._id, user: { name: builderUser.name, designation: 'Builder' } };

  const a201 = await s.unit('A-201');
  const b101 = await s.unit('B-101');
  const a101 = await s.unit('A-101');
  const soon = localDateString(addDays(new Date(), 5));
  await builder.schedulePossession(bctx, { unit: a201._id, buyerName: 'Vikram Singh', buyerPhone: '9000000014', date: soon, startTime: '10:00', endTime: '11:00' });
  await builder.schedulePossession(bctx, { unit: b101._id, buyerName: 'Anita Desai', buyerPhone: '9000000015', date: soon, startTime: '11:30', endTime: '12:30' });

  const tile = await builder.createSnag(bctx, { unit: a101._id, title: 'Cracked floor tile near the balcony door', category: 'flooring', location: 'Living room', contractor: { name: 'Shree Tiles & Co', phone: '9811111111' } });
  await builder.updateSnag(bctx, tile._id, { status: 'fixed', note: 'Tile replaced' });
  await builder.createSnag(bctx, { unit: a101._id, title: 'Bathroom exhaust fan not working', category: 'electrical', location: 'Common bathroom' });
  await builder.createSnag(bctx, { unit: a201._id, title: 'Seepage on bedroom wall', category: 'waterproofing', location: 'Bedroom 2', contractor: { name: 'DryWall Solutions', phone: '9822222222' } });

  await builder.postProgress(bctx, { title: 'Clubhouse interiors 80% complete', tower: 'Clubhouse', milestone: 'Interiors', percentComplete: 80, body: 'Flooring and false ceiling are done; gym equipment arrives next week.' });
  await builder.postProgress(bctx, { title: 'Tower B terrace waterproofing finished', tower: 'B', milestone: 'Terrace', percentComplete: 95 });
  await builder.getHandover(bctx);

  console.log(`  platformplus: standard plan invoices (${invoices.map((i) => i.number).join(', ')}), 2 support tickets, builder demo (builder@demo.test, "${admin?.name}" signs for the association)`);
}
