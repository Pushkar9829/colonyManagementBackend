import User from '../../src/modules/users/user.model.js';
import { ensureSystemRoles } from '../../src/modules/platformTeam/access.js';
import { recordPlatform } from '../../src/modules/platformTeam/platformAudit.js';

// Platform team demo members (superadmin@demo.test, created by seed.js, is the Owner). Like every other
// @demo.test account they are deleted and recreated on each run, so this is idempotent.
const MEMBERS = [
  ['Bhavna Rao', 'billing@demo.test', 'billing'],
  ['Sameer Khan', 'support@demo.test', 'support'],
  ['Varun Menon', 'viewer@demo.test', 'viewer'],
];

export default async function seed() {
  const roles = await ensureSystemRoles();
  const passwordHash = await User.hashPassword('Password@123');
  const owner = await User.findOne({ email: 'superadmin@demo.test' }).select('_id').lean();
  for (const [name, email, key] of MEMBERS) {
    await User.deleteOne({ email });
    const role = roles.find((r) => r.key === key);
    const user = await User.create({ name, email, passwordHash, platformRole: 'staff', platformRoleId: role._id, platformStatus: 'active', platformAddedAt: new Date() });
    await recordPlatform({ userId: owner?._id }, 'team.member_invited', { targetType: 'User', targetId: user._id, details: { name, email, role: role.name } });
  }
}
