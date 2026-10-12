import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './society.controller.js';
import * as schema from './society.validation.js';

const router = Router();
router.use(authenticate, requireSociety);

router.get('/me', controller.getMine);
router.patch('/me', authorize(), validate({ body: schema.updateProfile }), controller.updateProfile);
router.patch('/me/settings', authorize(), validate({ body: schema.updateSettings }), controller.updateSettings);
router.post('/me/regenerate-code', authorize(), controller.regenerateCode);
router.get('/setup-status', authorize(), controller.setupStatus);
router.post('/setup-status/dismiss', authorize(), controller.dismissSetup);

export default router;
