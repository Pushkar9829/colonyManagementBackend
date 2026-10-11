import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './support.controller.js';
import * as schema from './support.validation.js';

const { ACCOUNTANT, FACILITY_MANAGER } = ROLES;
const MANAGERS = [ACCOUNTANT, FACILITY_MANAGER];

// /api/v1/support — society management raising tickets with the platform team.
const router = Router();
router.use(authenticate, requireSociety);
router.get('/tickets', authorize(...MANAGERS), validate({ query: schema.listMine }), controller.list);
router.post('/tickets', authorize(...MANAGERS), validate({ body: schema.createTicket }), controller.create);
router.get('/tickets/:id', authorize(...MANAGERS), validate({ params: schema.idParams }), controller.getById);
router.post('/tickets/:id/messages', authorize(...MANAGERS), validate({ params: schema.idParams, body: schema.reply }), controller.reply);
router.post('/tickets/:id/close', authorize(...MANAGERS), validate({ params: schema.idParams, body: schema.close }), controller.close);
router.post('/tickets/:id/reopen', authorize(...MANAGERS), validate({ params: schema.idParams, body: schema.reopen }), controller.reopen);

export default router;

// Mounted inside /api/v1/platform (already behind authenticate + requirePlatformAdmin).
export const platformRouter = Router();
platformRouter.get('/support/stats', controller.stats);
platformRouter.get('/support/team', controller.team);
platformRouter.get('/support/tickets', validate({ query: schema.listAll }), controller.listAll);
platformRouter.get('/support/tickets/:id', validate({ params: schema.idParams }), controller.getAny);
platformRouter.post('/support/tickets/:id/messages', validate({ params: schema.idParams, body: schema.platformReply }), controller.platformReply);
platformRouter.post('/support/tickets/:id/status', validate({ params: schema.idParams, body: schema.setStatus }), controller.setStatus);
platformRouter.post('/support/tickets/:id/assign', validate({ params: schema.idParams, body: schema.assign }), controller.assign);
