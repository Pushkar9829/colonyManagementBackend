import ApiError from '../../common/errors/ApiError.js';
import { FEATURE_KEYS } from './features.catalogue.js';
import { isEnabled } from './features.service.js';

// Gate a router or route on a switchable module, after authenticate + requireSociety:
//   router.use(authenticate, requireSociety, requireFeature('parking'));
// Responds 402 FEATURE_DISABLED when the society's plan (or a platform override) does not include it.
export function requireFeature(key) {
  if (!FEATURE_KEYS.includes(key)) throw new Error(`requireFeature: unknown feature "${key}"`);
  return async (req, _res, next) => {
    try {
      if (!req.user?.society) throw ApiError.forbidden('Open a society to use this');
      if (!(await isEnabled(req.user.society, key))) {
        throw new ApiError(402, 'FEATURE_DISABLED', 'This module is not included in your society’s plan. Contact ColonyHub to enable it.', { feature: key });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export default requireFeature;
