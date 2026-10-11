import { Router } from 'express';
import { authenticate, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { idParams } from '../../common/utils/schemas.js';
import * as controller from './notifications.controller.js';
import { listQuery, pushSubscription, pushUnsubscribe } from './notifications.validation.js';

const router = Router();
router.use(authenticate, requireSociety);

router.get('/', validate({ query: listQuery }), controller.list);
router.get('/push/config', controller.pushConfig);
router.post('/push/subscribe', validate({ body: pushSubscription }), controller.subscribePush);
router.post('/push/unsubscribe', validate({ body: pushUnsubscribe }), controller.unsubscribePush);
router.post('/read-all', controller.markAllRead);
router.post('/:id/read', validate({ params: idParams }), controller.markRead);

export default router;
