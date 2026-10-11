import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './financeSettings.controller.js';
import * as schema from './financeSettings.validation.js';

const { ACCOUNTANT } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

router.get('/settings', authorize(ACCOUNTANT), controller.get);
router.patch('/settings', authorize(ACCOUNTANT), validate({ body: schema.updateSettings }), controller.update);

export default router;
