import mongoose from 'mongoose';
import User from '../../src/modules/users/user.model.js';
import Membership from '../../src/modules/users/membership.model.js';
import Society from '../../src/modules/society/society.model.js';
import { updatePrice } from '../../src/modules/subscriptions/subscriptions.service.js';
import PaymentSettings from '../../src/modules/paymentSettings/paymentSettings.model.js';
import Reseller from '../../src/modules/whitelabel/reseller.model.js';
import LicenceKey from '../../src/modules/whitelabel/licenceKey.model.js';
import ResellerInvoice from '../../src/modules/whitelabel/resellerInvoice.model.js';
import * as paymentSettings from '../../src/modules/paymentSettings/paymentSettings.service.js';
import * as whitelabel from '../../src/modules/whitelabel/whitelabel.service.js';
import { seal } from '../../src/common/utils/secretBox.js';
import { PLANS, ROLES } from '../../src/common/constants/index.js';

// Demo data for billing cycles, colony payments and white label:
// - plan prices with quarterly discounts and one-time licences
// - Green Valley (the demo society) takes online payments into its own (mock) Razorpay account
// - reseller "SmartNest Homes": 10 licence keys, 3 used by its demo societies (one of them on Razorpay Route,
//   linked account still pending), 7 unused (printed below), and a reseller admin reseller@demo.test.
// Idempotent: the reseller's societies and keys are removed and recreated on every run.
const PRICES = {
  basic: { quarterlyDiscountPercent: 5, oneTimePrice: 12000000, oneTimeValidityMonths: 36, description: 'Small societies: core modules plus parking, events and documents' },
  standard: { quarterlyDiscountPercent: 5, oneTimePrice: 25000000, oneTimeValidityMonths: 36, description: 'Most societies' },
  premium: { quarterlyDiscountPercent: 8, oneTimePrice: 50000000, oneTimeValidityMonths: null, description: 'Everything, lifetime licence available' },
};
const RESELLER_SLUG = 'smartnest';
const SOCIETIES = [
  { code: 'SNLAKE', name: 'SmartNest Lakeview', city: 'Bengaluru', admin: ['Lakeview Admin', 'lakeview@demo.test'], route: true },
  { code: 'SNORCH', name: 'SmartNest Orchid Towers', city: 'Bengaluru', admin: ['Orchid Admin', 'orchid@demo.test'] },
  { code: 'SNPALM', name: 'SmartNest Palm Court', city: 'Mysuru', admin: ['Palm Court Admin', 'palmcourt@demo.test'] },
];

async function removePrevious() {
  const old = await Society.find({ code: { $in: SOCIETIES.map((s) => s.code) } }).select('_id').lean();
  if (old.length) {
    const ids = old.map((s) => s._id);
    const collections = Object.values(mongoose.connection.collections).filter((c) => c.collectionName !== 'societies');
    await Promise.all(collections.map((c) => c.deleteMany({ society: { $in: ids } })));
    await Society.deleteMany({ _id: { $in: ids } });
  }
  const reseller = await Reseller.findOne({ slug: RESELLER_SLUG }).select('_id').lean();
  if (reseller) {
    await Promise.all([LicenceKey.deleteMany({ reseller: reseller._id }), ResellerInvoice.deleteMany({ reseller: reseller._id }), Reseller.deleteOne({ _id: reseller._id })]);
  }
}

export default async function seed(s) {
  const owner = await User.findOne({ platformRole: 'super_admin' }).lean();
  const passwordHash = await User.hashPassword('Password@123');

  for (const [plan, price] of Object.entries(PRICES)) {
    // updatePrice keeps the default monthly rates for fields it does not set.
    // eslint-disable-next-line no-await-in-loop
    await updatePrice(owner || {}, plan, price);
  }

  // Green Valley: own Razorpay account (mock keys; PAYMENT_PROVIDER=mock never calls Razorpay).
  await PaymentSettings.deleteOne({ society: s.sid });
  await paymentSettings.initForNewSociety(s.sid);
  await PaymentSettings.updateOne(
    { society: s.sid },
    {
      mode: 'own',
      enabled: true,
      status: 'active',
      activatedAt: new Date(),
      activatedBy: (await s.user('admin@demo.test'))?._id,
      own: {
        keyId: 'rzp_test_GreenValleyDemo',
        keySecret: seal('demo_secret_green_valley_01', 'payments.keySecret'),
        keySecretLast4: 'y_01',
        webhookSecret: seal('demo_webhook_green_valley', 'payments.webhookSecret'),
        webhookSecretLast4: 'lley',
        connection: { ok: true, at: new Date() },
      },
      testPayment: { ok: true, at: new Date(), mode: 'own', amount: 100, orderId: 'mock_order_demo_test', paymentId: 'mock_pay_demo_test' },
    },
  );

  await removePrevious();
  if (!owner) return;
  const reseller = await whitelabel.createReseller(owner, {
    name: 'SmartNest Homes',
    slug: RESELLER_SLUG,
    brand: { appName: 'SmartNest Living', primaryColor: '#0f766e', supportEmail: 'help@smartnest.test', supportPhone: '+91 80 4000 1234', customDomain: 'app.smartnest.test' },
    contact: { name: 'Kavya Iyer', email: 'kavya@smartnest.test', phone: '+919800000101' },
    notes: 'Demo white-label partner',
  });
  const { keys } = await whitelabel.generateKeys(owner, reseller._id, { count: 10, plan: 'standard', cycle: 'yearly', pricePerKey: 1200000 });

  await User.deleteOne({ email: 'reseller@demo.test' });
  await User.create({ name: 'Kavya Iyer', email: 'reseller@demo.test', passwordHash, reseller: reseller._id });

  for (const [i, def] of SOCIETIES.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const society = await Society.create({ name: def.name, code: def.code, city: def.city, state: 'Karnataka', contactEmail: def.admin[1], plan: { name: 'trial', unitLimit: PLANS.trial.unitLimit, validUntil: new Date(Date.now() + 30 * 86400000) } });
    // eslint-disable-next-line no-await-in-loop
    await User.deleteOne({ email: def.admin[1] });
    // eslint-disable-next-line no-await-in-loop
    const admin = await User.create({ name: def.admin[0], email: def.admin[1], passwordHash });
    // eslint-disable-next-line no-await-in-loop
    const m = await Membership.create({ user: admin._id, society: society._id, role: ROLES.ADMIN, status: 'active' });
    // eslint-disable-next-line no-await-in-loop
    await User.updateOne({ _id: admin._id }, { lastMembership: m._id });
    // eslint-disable-next-line no-await-in-loop
    await paymentSettings.initForNewSociety(society._id);
    // eslint-disable-next-line no-await-in-loop
    await whitelabel.activateKey({ societyId: society._id, userId: admin._id }, keys[i]);
    if (def.route) {
      // Route: the platform registered the linked account; Razorpay is still checking its KYC.
      // eslint-disable-next-line no-await-in-loop
      await paymentSettings.chooseMode({ societyId: society._id, userId: admin._id }, 'route');
      // eslint-disable-next-line no-await-in-loop
      await paymentSettings.platformUpdate(owner, society._id, {
        route: { linkedAccountId: 'acc_demoLakeviewpending', status: 'pending', kycStatus: 'under_review', commissionPercent: 1, bank: { accountName: 'SmartNest Lakeview Owners Assn', accountLast4: '4321', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' } },
      });
    }
  }
  console.log(`White label demo: SmartNest Homes (login reseller@demo.test, brand ?brand=${RESELLER_SLUG}). Unused licence keys:\n  ${keys.slice(SOCIETIES.length).join('\n  ')}`);
}
