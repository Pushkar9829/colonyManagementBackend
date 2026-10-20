// Demo data for member personal details, birthday / anniversary wishes and WhatsApp credits.
// Dates are relative to seed time: Ravi's birthday is today and Ravi & Priya's anniversary is in 3 days.
import PersonalDetails from '../../src/modules/people/personalDetails.model.js';
import Household from '../../src/modules/household/household.model.js';
import DirectoryProfile from '../../src/modules/directory/directoryProfile.model.js';
import CelebrationSettings from '../../src/modules/celebrations/celebrationSettings.model.js';
import WhatsAppAccount from '../../src/modules/whatsapp/whatsappAccount.model.js';
import WhatsAppCredit from '../../src/modules/whatsapp/whatsappCredit.model.js';
import { localDateString } from '../../src/common/utils/dates.js';

const day = (offset) => localDateString(Date.now() + offset * 86400000);
// Same day and month `offset` days from now, `years` years back (29 Feb moves to 28 Feb).
const yearsBack = (offset, years) => {
  const d = day(offset);
  const md = d.slice(5) === '02-29' ? '02-28' : d.slice(5);
  return `${Number(d.slice(0, 4)) - years}-${md}`;
};
const working = (mode, category, organisation, designation, extra = {}) => ({ type: 'working', working: { mode, category, organisation, designation, ...extra } });

export default async function seed(s) {
  const { sid } = s;
  const people = [
    ['resident@demo.test', { dateOfBirth: yearsBack(0, 41), anniversaryDate: yearsBack(3, 14), gender: 'male', occupation: working('job', 'it_software', 'Infosys', 'Senior Architect', { workAddress: 'Hinjewadi Phase 1, Pune' }) }],
    ['priya@demo.test', { dateOfBirth: '1987-08-19', anniversaryDate: yearsBack(3, 14), gender: 'female', occupation: working('job', 'healthcare', 'Ruby Hall Clinic', 'Paediatrician') }],
    ['neha@demo.test', { dateOfBirth: '1995-01-24', gender: 'female', occupation: working('job', 'it_software', 'Persistent Systems', 'QA Lead') }],
    ['vikram@demo.test', { dateOfBirth: '1978-11-02', anniversaryDate: '2004-12-12', gender: 'male', occupation: working('business', 'retail_trade', 'Singh Electronics', 'Owner', { details: 'Electronics showroom on FC Road' }) }],
    ['anita@demo.test', { dateOfBirth: '1982-04-15', gender: 'female', occupation: working('self_employed', 'healthcare', 'Desai Physiotherapy', 'Physiotherapist') }],
    ['karan@demo.test', { dateOfBirth: '2004-06-30', gender: 'male', occupation: { type: 'student', student: { institutionName: 'COEP Pune', institutionType: 'college', course: 'B.Tech Computer Engineering', address: 'Wellesley Road, Shivajinagar, Pune' } } }],
  ];
  for (const [email, details] of people) {
    // eslint-disable-next-line no-await-in-loop
    const user = await s.user(email);
    if (!user) continue;
    // eslint-disable-next-line no-await-in-loop
    await new PersonalDetails({ society: sid, user: user._id, ...details, updatedBy: user._id }).save();
    // eslint-disable-next-line no-await-in-loop
    await DirectoryProfile.updateOne(
      { society: sid, user: user._id },
      { $set: { showBirthday: true, showOccupation: true }, $setOnInsert: { society: sid, user: user._id, listed: true } },
      { upsert: true },
    );
  }

  // A-101's son goes to school; his grandmother is retired.
  const a101 = await s.unit('A-101');
  if (a101) {
    await Household.updateOne(
      { society: sid, unit: a101._id, 'members.name': 'Aarav Iyer' },
      { $set: { 'members.$.gender': 'male', 'members.$.showBirthday': true, 'members.$.occupation': { type: 'student', student: { institutionName: 'Delhi Public School, Pune', institutionType: 'school', course: 'Class 5' } } } },
    );
    await Household.updateOne(
      { society: sid, unit: a101._id, 'members.name': 'Kamala Iyer' },
      { $set: { 'members.$.gender': 'female', 'members.$.occupation': { type: 'retired', notes: 'Retired school principal' } } },
    );
  }

  await CelebrationSettings.create({ society: sid, enabled: true, sendTime: '08:00', language: 'en' });

  // WhatsApp in automatic (api) mode: 600 credits granted two months ago, 100 used since, 500 left.
  const admin = (await s.user('admin@demo.test'))?._id;
  await WhatsAppAccount.create({ society: sid, mode: 'api', balance: 500, lowBalanceThreshold: 50 });
  const start = Date.now() - 60 * 86400000;
  const rows = [{ society: sid, entry: 'grant', amount: 600, balanceAfter: 600, note: 'Launch pack (demo)', by: admin, createdAt: new Date(start) }];
  const kinds = [['bill', 34], ['receipt', 22], ['reminder', 28], ['wishes', 9], ['notice', 4], ['sos', 3]];
  let balance = 600;
  let i = 0;
  for (const [kind, n] of kinds) {
    for (let k = 0; k < n; k += 1) {
      balance -= 1;
      i += 1;
      rows.push({ society: sid, entry: 'debit', amount: -1, kind, balanceAfter: balance, to: `******${String(1000 + (i % 90)).slice(-4)}`, createdAt: new Date(start + i * 0.55 * 86400000) });
    }
  }
  // One provider rejection, refunded.
  rows.push({ society: sid, entry: 'debit', amount: -1, kind: 'bill', balanceAfter: balance - 1, to: '******0011', createdAt: new Date(Date.now() - 2 * 86400000) });
  rows.push({ society: sid, entry: 'refund', amount: 1, kind: 'bill', balanceAfter: balance, note: 'WhatsApp send failed (400)', to: '******0011', createdAt: new Date(Date.now() - 2 * 86400000 + 1000) });
  await WhatsAppCredit.insertMany(rows);
}
