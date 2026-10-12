import jwt from 'jsonwebtoken';
import env from '../../config/env.js';
import ApiError from '../errors/ApiError.js';
import { loadPrincipal } from '../../modules/users/principal.js';
import { ROLES } from '../constants/index.js';

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

export const requirePlatformAdmin = (req, _res, next) =>
  req.user?.platformRole === 'super_admin' ? next() : next(ApiError.forbidden('Platform admins only'));
