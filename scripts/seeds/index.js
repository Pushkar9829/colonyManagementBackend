// Demo data contributed by feature modules (run after the core demo society is created).
// Each seed is `export default async function seed(s) { ... }` where `s` is the seed context:
//   s.society, s.sid, s.ctx (admin ctx for service calls), s.user(email) -> user doc,
//   s.membership(email) -> membership doc, s.unit(label) -> unit doc
// Add one import line and one array entry per module.
// ---- seed imports (add below this line) ----
import templatesSeed from './templates.js';
import billingWhitelabelSeed from './billingWhitelabel.js';
import adsSeed from './ads.js';
import membersSeed from './members.js';
import gatesSeed from './gates.js';
import platformTeamSeed from './platformTeam.js';
import securitySeed from './security.js';
import residentsSeed from './residents.js';
import governanceSeed from './governance.js';
import platformplusSeed from './platformplus.js';
import billingplusSeed from './billingplus.js';
import facilitySeed from './facility.js';
import accountsSeed from './accounts.js';
import community from './community.js';
import luckyDrawSeed from './luckyDraw.js';

export const SEEDS = [
  // ---- seed entries (add below this line) ----
  billingWhitelabelSeed,
  templatesSeed, // after billingWhitelabel (SmartNest reseller and its societies)
  adsSeed,
  platformTeamSeed,
  securitySeed,
  residentsSeed,
  governanceSeed,
  platformplusSeed,
  billingplusSeed,
  facilitySeed,
  accountsSeed,
  community,
  luckyDrawSeed,
  membersSeed, // after residents (households) and community (directory profiles)
  gatesSeed, // last: spreads the visitors / movements seeded above over the gates
];
