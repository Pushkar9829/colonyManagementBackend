import { Router } from 'express';
import { authenticate, requirePlatform, requireSociety } from '../../common/middleware/auth.js';
import { audited } from '../platformTeam/platformAudit.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './features.controller.js';
import * as schema from './features.validation.js';

// /api/v1/features — any member of the open society may read which modules are on.
const router = Router();
router.use(authenticate, requireSociety);
router.get('/', controller.mine);

export default router;

// Mounted inside /api/v1/platform (already behind authenticate + any platform member). The catalogue is
// reference data every member may read; the per-society switches need their own permissions.
export const platformRouter = Router();
platformRouter.get('/features/catalogue', controller.catalogue);
platformRouter.get('/societies/:id/features', requirePlatform('societies.view'), validate({ params: schema.idParams }), controller.forSociety);
platformRouter.put('/societies/:id/features', requirePlatform('societies.features'), validate({ params: schema.idParams, body: schema.setOverrides }),
  audited('society.features_changed', { targetType: 'Society' }), controller.setOverrides);
