import User from '../users/user.model.js';
import PlatformRole from './platformRole.model.js';
import { ALL_PERMISSIONS, SYSTEM_ROLES, isPermission } from './permissions.js';

// Who is on the platform team. Owners keep the historic platformRole 'super_admin'; everyone else is 'staff'
// with a platformRoleId. platformStatus 'inactive' switches platform access off without touching the account
// (they may still be a resident somewhere).
export const OWNER = 'super_admin';
export const STAFF = 'staff';
export const USER_PLATFORM_FIELDS = 'status platformRole platformRoleId platformStatus';

export const isOwner = (user) => user?.platformRole === OWNER;

// Active platform members only: owners and staff with a role. Inactive accounts never qualify.
const activeMember = { status: 'active', platformStatus: { $ne: 'inactive' } };
export const activeOwnersFilter = () => ({ ...activeMember, platformRole: OWNER });

// The permissions the user holds in the platform console, or null if they are not an active platform member.
// `user` needs the USER_PLATFORM_FIELDS.
export async function permissionsFor(user) {
  if (!user?.platformRole || user.status !== 'active' || user.platformStatus === 'inactive') return null;
  if (user.platformRole === OWNER) return [...ALL_PERMISSIONS];
  if (!user.platformRoleId) return null;
  const role = await PlatformRole.findById(user.platformRoleId).select('permissions').lean();
  return role ? role.permissions.filter(isPermission) : null;
}

export const hasPlatformAccess = async (user) => Boolean(await permissionsFor(user));

// Active members who hold `permission` (owners always do). Used for ticket assignees and platform emails.
export async function membersWithPermission(permission, select = 'name email') {
  const roleIds = await PlatformRole.distinct('_id', { permissions: permission });
  return User.find({ ...activeMember, $or: [{ platformRole: OWNER }, { platformRole: STAFF, platformRoleId: { $in: roleIds } }] })
    .select(select)
    .sort({ name: 1 })
    .lean();
}

// Creates the built-in roles, and keeps their permissions in line with the code. Idempotent.
export async function ensureSystemRoles() {
  await PlatformRole.bulkWrite(
    SYSTEM_ROLES.map((r) => ({
      updateOne: {
        filter: { key: r.key },
        update: { $set: { name: r.name, description: r.description, permissions: r.permissions, system: true } },
        upsert: true,
      },
    })),
  );
  return PlatformRole.find({ system: true }).lean();
}

export const systemRole = async (key) => (await ensureSystemRoles()).find((r) => r.key === key);
