import jwt from 'jsonwebtoken';
import env from '../../config/env.js';
import ApiError from '../errors/ApiError.js';
import { loadPrincipal } from '../../modules/users/principal.js';
import { ROLES } from '../constants/index.js';
import { isPermission } from '../../modules/platformTeam/permissions.js';

// Verifies the bearer access token and loads the user + active membership onto req.user.
export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw ApiError.unauthorized();

    let payload;
    try {
      payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
    } catch {
      throw new ApiError(401, 'TOKEN_INVALID', 'Access token is invalid or expired');
    }
    req.user = await loadPrincipal(payload.sub, payload.mid);
    if (req.user.mfaSetupRequired && !req.originalUrl.split('?')[0].startsWith('/api/v1/auth/')) {
      throw new ApiError(403, 'MFA_SETUP_REQUIRED', 'Turn on two-step verification to continue');
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Society routes: allows the given roles; the society admin always passes.
// A platform (super admin) session has no society and is rejected here.
export const authorize = (...roles) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!req.user.society) return next(ApiError.forbidden('Open a society to use this'));
  if (req.user.role === ROLES.ADMIN || roles.includes(req.user.role)) return next();
  return next(ApiError.forbidden());
};

// Society-scoped routes that every member may use (no role restriction).
export const requireSociety = (req, _res, next) => (req.user?.society ? next() : next(ApiError.forbidden('Open a society to use this')));

// Platform console routes. The principal carries platformPermissions (owners hold all of them; see
// modules/platformTeam). requirePlatform() with no keys means "any active platform team member";
// with keys, every one of them is required.
const checkPermissions = (perms) => {
  const unknown = perms.filter((p) => !isPermission(p));
  if (unknown.length) throw new Error(`Unknown platform permission: ${unknown.join(', ')}`);
};
const platformGuard = (perms, test) => {
  checkPermissions(perms);
  return (req, _res, next) => {
    const held = req.user?.platformPermissions;
    if (!held) return next(ApiError.forbidden('Platform team only'));
    if (!perms.length || test(perms, held)) return next();
    return next(new ApiError(403, 'PERMISSION_DENIED', 'Your platform role does not allow this'));
  };
};
export const requirePlatform = (...perms) => platformGuard(perms, (p, held) => p.every((k) => held.includes(k)));
export const requirePlatformAny = (...perms) => platformGuard(perms, (p, held) => p.some((k) => held.includes(k)));

// Kept for older imports: any member of the platform team.
export const requirePlatformAdmin = requirePlatform();
