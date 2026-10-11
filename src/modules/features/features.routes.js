import { Router } from 'express';
import { authenticate, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './features.controller.js';
import * as schema from './features.validation.js';

// /api/v1/features — any member of the open society may read which modules are on.
const router = Router();
router.use(authenticate, requireSociety);
router.get('/', controller.mine);

export default router;

// Mounted inside /api/v1/platform (already behind authenticate + requirePlatformAdmin).
export const platformRouter = Router();
platformRouter.get('/features/catalogue', controller.catalogue);
platformRouter.get('/societies/:id/features', validate({ params: schema.idParams }), controller.forSociety);
platformRouter.put('/societies/:id/features', validate({ params: schema.idParams, body: schema.setOverrides }), controller.setOverrides);
