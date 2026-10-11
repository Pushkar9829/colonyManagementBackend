import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './directory.controller.js';
import * as schema from './directory.validation.js';

// Guards and staff use chat / notices / events only; the directory is for residents and management.
const COMMUNITY = [ROLES.RESIDENT, ROLES.FACILITY_MANAGER, ROLES.ACCOUNTANT];
const router = Router();
router.use(authenticate, requireSociety, authorize(...COMMUNITY));

router.get('/me', controller.getMine);
router.patch('/me', validate({ body: schema.updateMine }), controller.updateMine);
router.get('/contacts', controller.contacts);
router.get('/', validate({ query: schema.listDirectory }), controller.list);

export default router;
