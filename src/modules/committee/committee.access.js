import ApiError from '../../common/errors/ApiError.js';
import { ctx } from '../../common/utils/context.js';
import { canManage } from './committee.service.js';

// Route guard for governance actions: society admins and sitting committee office-bearers.
// Committee members are usually residents, so a plain role check (authorize) cannot express this.
export function requireGovernance(req, _res, next) {
  if (!req.user?.society) return next(ApiError.forbidden('Open a society to use this'));
  return canManage(ctx(req))
    .then((ok) => (ok ? next() : next(ApiError.forbidden('Only the managing committee can do this'))))
    .catch(next);
}

// Governance, or one of the listed roles (e.g. guards reading today's move-ins).
export const governanceOr = (...roles) => (req, res, next) => {
  if (req.user?.society && roles.includes(req.user.role)) return next();
  return requireGovernance(req, res, next);
};
