// Seeds a demo society. Usage: npm run seed   (add --reset to wipe the demo society first)
// Refuses to run when NODE_ENV=production.
import mongoose from 'mongoose';
import env from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import Society from '../src/modules/society/society.model.js';
import User from '../src/modules/users/user.model.js';
import Membership from '../src/modules/users/membership.model.js';
import Block from '../src/modules/units/block.model.js';
import Unit from '../src/modules/units/unit.model.js';
import Amenity from '../src/modules/amenities/amenity.model.js';
import Notice from '../src/modules/notices/notice.model.js';
import Poll from '../src/modules/polls/poll.model.js';
import DailyHelp from '../src/modules/dailyHelp/dailyHelp.model.js';
import * as unitsService from '../src/modules/units/units.service.js';
import * as billingService from '../src/modules/billing/billing.service.js';
import { localPeriod } from '../src/common/utils/dates.js';
import { SEEDS } from './seeds/index.js';

const DEMO_CODE = 'DEMO01';
const PASSWORD = 'Password@123';

if (env.isProd) {
  console.error('Refusing to seed in production');
  process.exit(1);
}

await connectDB();

const existing = await Society.findOne({ code: DEMO_CODE });
if (existing && !process.argv.includes('--reset')) {
  console.log('Demo society already exists. Run "npm run seed -- --reset" to recreate it.');
  await mongoose.disconnect();
  process.exit(0);
}
if (existing) {
  const collections = Object.values(mongoose.connection.collections);
  await Promise.all(collections.filter((c) => c.collectionName !== 'societies').map((c) => c.deleteMany({ society: existing._id })));
  await existing.deleteOne();
}
// Demo accounts are recreated every time (all use @demo.test addresses).
{
  const demoUsers = await User.find({ email: /@demo\.test$/ }).select('_id').lean();
  const ids = demoUsers.map((u) => u._id);
  await mongoose.connection.collection('refreshtokens').deleteMany({ user: { $in: ids } });
  await Membership.deleteMany({ user: { $in: ids } });
  await User.deleteMany({ _id: { $in: ids } });
}

const society = await Society.create({
  name: 'Green Valley Residency',
  code: DEMO_CODE,
  address: '12 Baner Road',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411045',
  settings: {
    billing: { perSqftRate: 300, fixedAmount: 50000, chargeHeads: [{ name: 'Sinking fund', amount: 20000 }], dueDays: 15, lateFeeType: 'percent', lateFeeValue: 2 },
  },
});
const sid = society._id;
const ctx = { societyId: sid, userId: undefined, role: 'admin' };

const passwordHash = await User.hashPassword(PASSWORD);
// Creates the login and its membership in the demo society.
async function mkUser({ name, email, phone, role, unit, residentType, designation, status = 'active' }) {
  const user = await User.create({ name, email, phone, passwordHash });
  const m = await Membership.create({ user: user._id, society: sid, role, unit, residentType, designation, status });
  await User.updateOne({ _id: user._id }, { lastMembership: m._id });
  return user;
}

const admin = await mkUser({ name: 'Asha Kulkarni', email: 'admin@demo.test', phone: '9000000001', role: 'admin', designation: 'Secretary' });
ctx.userId = admin._id;

const blocks = await Block.insertMany([{ society: sid, name: 'A', floors: 4 }, { society: sid, name: 'B', floors: 4 }]);
for (const b of blocks) {
  // eslint-disable-next-line no-await-in-loop
  await unitsService.bulkCreate(ctx, { block: b._id, fromFloor: 1, toFloor: 4, unitsPerFloor: 4, type: 'flat', areaSqft: b.name === 'A' ? 1100 : 1450 });
}
const unit = (label) => Unit.findOne({ society: sid, label }).lean();

await mkUser({ name: 'Rohit Sharma', email: 'accountant@demo.test', phone: '9000000002', role: 'accountant', designation: 'Treasurer' });
await mkUser({ name: 'Meera Joshi', email: 'manager@demo.test', phone: '9000000003', role: 'facility_manager', designation: 'Facility Manager' });
await mkUser({ name: 'Ramesh Yadav', email: 'guard@demo.test', phone: '9000000004', role: 'guard', designation: 'Main Gate' });
await mkUser({ name: 'Suresh Patil', email: 'plumber@demo.test', phone: '9000000005', role: 'staff', designation: 'Plumber' });
await mkUser({ name: 'Arjun Mehta', email: 'electrician@demo.test', phone: '9000000006', role: 'staff', designation: 'Electrician' });

const residents = [
  ['Ravi Iyer', 'resident@demo.test', '9000000011', 'A-101', 'owner'],
  ['Priya Iyer', 'priya@demo.test', '9000000012', 'A-101', 'family'],
  ['Neha Gupta', 'neha@demo.test', '9000000013', 'A-102', 'tenant'],
  ['Vikram Singh', 'vikram@demo.test', '9000000014', 'A-201', 'owner'],
  ['Anita Desai', 'anita@demo.test', '9000000015', 'B-101', 'owner'],
  ['Karan Shah', 'karan@demo.test', '9000000016', 'B-302', 'tenant'],
];
for (const [name, email, phone, label, residentType] of residents) {
  // eslint-disable-next-line no-await-in-loop
  const u = await unit(label);
  // eslint-disable-next-line no-await-in-loop
  await mkUser({ name, email, phone, role: 'resident', unit: u._id, residentType });
  // eslint-disable-next-line no-await-in-loop
  await unitsService.refreshOccupancy(sid, u._id);
}
// Ravi also owns A-104 (shows the home switcher)
{
  const ravi = await User.findOne({ email: 'resident@demo.test' }).lean();
  const a104 = await unit('A-104');
  await Membership.create({ user: ravi._id, society: sid, role: 'resident', unit: a104._id, residentType: 'owner', status: 'active' });
  await unitsService.refreshOccupancy(sid, a104._id);
}
// one pending join request to show the approval flow
await mkUser({ name: 'Pending Person', email: 'pending@demo.test', role: 'resident', residentType: 'owner', unit: (await unit('B-401'))._id, status: 'pending' });
// platform owner (super admin console)
await User.create({ name: 'Platform Owner', email: 'superadmin@demo.test', passwordHash, platformRole: 'super_admin' });

await Amenity.insertMany([
  { society: sid, name: 'Clubhouse', description: 'Party hall for up to 80 guests', capacity: 1, openTime: '09:00', closeTime: '23:00', slotMinutes: 240, requiresApproval: true, fee: 200000 },
  { society: sid, name: 'Badminton Court', description: 'Indoor wooden court', capacity: 1, openTime: '06:00', closeTime: '22:00', slotMinutes: 60, maxBookingsPerUnitPerDay: 1 },
  { society: sid, name: 'Gym', description: 'Cardio and weights', capacity: 10, openTime: '05:00', closeTime: '23:00', slotMinutes: 60, maxBookingsPerUnitPerDay: 2 },
]);

await Notice.insertMany([
  { society: sid, title: 'Water tank cleaning on Saturday', body: 'Water supply will be off from 10 AM to 2 PM this Saturday for tank cleaning. Please store water in advance.', category: 'maintenance', pinned: true, createdBy: admin._id },
  { society: sid, title: 'Diwali celebration', body: 'Join us at the clubhouse lawn on Sunday at 7 PM for Diwali celebrations, dinner and fireworks.', category: 'event', createdBy: admin._id },
]);
await Poll.create({
  society: sid,
  question: 'Should we install EV charging points in the basement?',
  options: [{ text: 'Yes' }, { text: 'No' }, { text: 'Need more details' }],
  createdBy: admin._id,
  closesAt: new Date(Date.now() + 14 * 86400000),
});
await DailyHelp.create({ society: sid, name: 'Sunita Bai', phone: '9100000001', type: 'maid', units: [(await unit('A-101'))._id, (await unit('A-102'))._id], passcode: '482913', createdBy: admin._id });

const bills = await billingService.generate(ctx, { period: localPeriod() });

// Feature-module demo data
const seedCtx = {
  society,
  sid,
  ctx,
  user: (email) => User.findOne({ email }).lean(),
  membership: async (email) => {
    const u = await User.findOne({ email }).select('_id').lean();
    return u && Membership.findOne({ user: u._id, society: sid }).lean();
  },
  unit,
};
for (const seed of SEEDS) {
  // eslint-disable-next-line no-await-in-loop
  await seed(seedCtx);
}
// The demo should show every module, whatever plan the platform seed picked.
{
  const { FEATURE_KEYS } = await import('../src/modules/features/features.catalogue.js');
  const { default: SocietyFeatures } = await import('../src/modules/features/societyFeatures.model.js');
  const superAdmin = await User.findOne({ platformRole: 'super_admin' }).select('_id').lean();
  await SocietyFeatures.findOneAndUpdate(
    { society: sid },
    { society: sid, overrides: FEATURE_KEYS.map((key) => ({ key, enabled: true, by: superAdmin?._id, at: new Date(), note: 'demo' })) },
    { upsert: true },
  );
}

console.log(`
Seeded "${society.name}" (join code ${DEMO_CODE}) with 32 units and ${bills.created} bills.
All demo accounts use the password: ${PASSWORD}
  admin@demo.test        Society admin
  accountant@demo.test   Accountant
  manager@demo.test      Facility manager
  guard@demo.test        Security guard
  plumber@demo.test      Staff (technician)
  resident@demo.test     Resident (owns A-101 and A-104)
  superadmin@demo.test   Platform owner console
  billing@demo.test      Platform team: Billing
  support@demo.test      Platform team: Support
  viewer@demo.test       Platform team: Viewer (read-only)
  neha@demo.test         Resident (A-102, tenant)
Daily help passcode for gate testing: 482913
`);
// let fire-and-forget notification deliveries (push / WhatsApp) finish before closing the connection
await new Promise((r) => setTimeout(r, 2000));
await mongoose.disconnect();
