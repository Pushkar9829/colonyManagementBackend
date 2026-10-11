import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './polls.controller.js';
import * as schema from './polls.validation.js';

const router = Router();
router.use(authenticate, requireSociety);

router.get('/', validate({ query: schema.listPolls }), controller.list);
router.post('/', authorize(ROLES.FACILITY_MANAGER), validate({ body: schema.createPoll }), controller.create);
router.post('/:id/vote', validate({ params: schema.idParams, body: schema.vote }), controller.vote);
router.post('/:id/close', authorize(ROLES.FACILITY_MANAGER), validate({ params: schema.idParams }), controller.close);
router.get('/:id/voters', authorize(ROLES.FACILITY_MANAGER), validate({ params: schema.idParams }), controller.voters);

export default router;
