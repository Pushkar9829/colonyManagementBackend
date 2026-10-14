import LuckyDraw from '../../src/modules/luckyDraw/luckyDraw.model.js';
import LuckyDrawEntry from '../../src/modules/luckyDraw/luckyDrawEntry.model.js';
import { ALGORITHM, assign, entriesHash, newSeed, sha256 } from '../../src/modules/luckyDraw/fairness.js';
import Unit from '../../src/modules/units/unit.model.js';
import { nextNumber } from '../../src/modules/counter/counter.service.js';
import { addDays } from '../../src/common/utils/dates.js';

// Lucky draw demo: one open "Diwali Bumper Draw" with a few entries, and one finished draw whose
// results and revealed seed can be verified on the page. (The demo society gets every feature switched
// on by scripts/seed.js, so the luckyDraw module is visible whatever plan it is on.)
export default async function seed(s) {
  const { sid } = s;
  const admin = await s.user('admin@demo.test');
  if (!admin) return;
  const people = [];
  for (const email of ['resident@demo.test', 'neha@demo.test', 'vikram@demo.test', 'anita@demo.test', 'karan@demo.test', 'priya@demo.test']) {
    // eslint-disable-next-line no-await-in-loop
    const [u, m] = await Promise.all([s.user(email), s.membership(email)]);
    if (u && m?.unit) people.push({ user: u, unit: m.unit });
  }
  const now = new Date();
  const labelOf = async (unitId) => (await Unit.findById(unitId).select('label').lean())?.label;
  const terms = 'Entry is free and open to residents. One prize per person. Prizes cannot be exchanged for cash. The committee\'s decision on eligibility is final.';

  // open draw
  const seedOpen = newSeed();
  const diwali = await LuckyDraw.create({
    society: sid, number: await nextNumber(sid, 'luckyDraw', 'LD'), title: 'Diwali Bumper Draw',
    description: 'Celebrate Diwali with the society! Join for free — winners announced on Diwali evening at the clubhouse.',
    terms, createdBy: admin._id, status: 'open', publishedAt: addDays(now, -2), reserves: 3,
    prizes: [
      { title: '43" Smart TV', quantity: 1, value: 'Worth ₹28,000' },
      { title: 'Air fryer', quantity: 2, value: 'Worth ₹6,500' },
      { title: '₹1,000 gift voucher', quantity: 5 },
    ],
    eligibility: { audience: 'all_residents', perFlat: false, excludeCommittee: false },
    entryOpensAt: addDays(now, -2), entryClosesAt: addDays(now, 5), drawAt: addDays(now, 5.1),
    fairness: { seed: seedOpen, seedHash: sha256(seedOpen), algorithm: ALGORITHM },
  });
  for (const p of people.slice(0, 4)) {
    // eslint-disable-next-line no-await-in-loop
    await LuckyDrawEntry.create({ society: sid, draw: diwali._id, user: p.user._id, unit: p.unit, name: p.user.name, unitLabel: await labelOf(p.unit) });
  }

  // finished draw, results computed with the real algorithm so "Verify" checks out
  const seedPast = newSeed();
  const past = await LuckyDraw.create({
    society: sid, number: await nextNumber(sid, 'luckyDraw', 'LD'), title: 'Independence Day Draw',
    description: 'A small thank-you draw for everyone who joined the flag hoisting.', terms, createdBy: admin._id,
    status: 'closed', publishedAt: addDays(now, -70), closedAt: addDays(now, -60), reserves: 1,
    prizes: [{ title: 'Bicycle', quantity: 1 }, { title: 'Movie tickets for two', quantity: 2 }],
    eligibility: { audience: 'all_residents', perFlat: true },
    entryOpensAt: addDays(now, -70), entryClosesAt: addDays(now, -60), drawAt: addDays(now, -60),
    fairness: { seed: seedPast, seedHash: sha256(seedPast), algorithm: ALGORITHM },
  });
  const byUnit = new Map();
  for (const p of people) if (!byUnit.has(String(p.unit))) byUnit.set(String(p.unit), p);
  const entries = [];
  for (const p of byUnit.values()) {
    // eslint-disable-next-line no-await-in-loop
    entries.push((await LuckyDrawEntry.create({ society: sid, draw: past._id, user: p.user._id, unit: p.unit, name: p.user.name, unitLabel: await labelOf(p.unit), perFlat: true })).toObject());
  }
  const { results, reserves } = assign(seedPast, entries, past.prizes, { perFlat: true, reserves: 1 });
  const slot = ({ entry, position }) => ({ entry: entry._id, user: entry.user, unit: entry.unit, name: entry.name, unitLabel: entry.unitLabel, position });
  await LuckyDraw.updateOne({ _id: past._id }, {
    $set: {
      status: 'drawn', drawnAt: addDays(now, -60), drawnBy: 'scheduler',
      results: results.map((r, i) => ({ prize: r.prize, title: past.prizes[i].title, winners: r.winners.map((w, j) => ({ ...slot(w), ...(i === 0 && j === 0 ? { handedOverAt: addDays(now, -58), handedOverBy: admin._id, handoverNote: 'Collected from the society office' } : {}) })) })),
      reservesList: reserves.map(slot),
      'fairness.entriesHash': entriesHash(entries.map((e) => e._id)),
      'fairness.entryCount': entries.length,
    },
  });
}
