import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './sos.controller.js';
import * as schema from './sos.validation.js';

const { GUARD, RESIDENT, FACILITY_MANAGER } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

router.post('/', validate({ body: schema.raise }), controller.raise); // anyone can raise
router.get('/', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listAlerts }), controller.list);
router.post('/:id/acknowledge', authorize(GUARD, FACILITY_MANAGER), validate({ params: schema.idParams }), controller.acknowledge);
router.post('/:id/resolve', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.resolve }), controller.resolve);

export default router;
