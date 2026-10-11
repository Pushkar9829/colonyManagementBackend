import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './notices.controller.js';
import * as schema from './notices.validation.js';

const router = Router();
router.use(authenticate, requireSociety);

router.get('/', validate({ query: schema.listNotices }), controller.list);
router.post('/', authorize(ROLES.FACILITY_MANAGER), validate({ body: schema.createNotice }), controller.create);
router.post('/:id/read', validate({ params: schema.idParams }), controller.markRead);
router.post('/:id/ack', validate({ params: schema.idParams }), controller.acknowledge);
router.get('/:id/acks', authorize(ROLES.FACILITY_MANAGER), validate({ params: schema.idParams }), controller.ackStatus);
router.post('/:id/acks/remind', authorize(ROLES.FACILITY_MANAGER), validate({ params: schema.idParams }), controller.remindPending);
router.patch('/:id', authorize(ROLES.FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.updateNotice }), controller.update);
router.delete('/:id', authorize(ROLES.FACILITY_MANAGER), validate({ params: schema.idParams }), controller.remove);

export default router;
