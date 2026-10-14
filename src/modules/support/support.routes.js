import { Router } from 'express';
import { authenticate, authorize, requirePlatform, requireSociety } from '../../common/middleware/auth.js';
import { audited } from '../platformTeam/platformAudit.js';
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

// Mounted inside /api/v1/platform (already behind authenticate + any platform member); each route needs its
// own platform permission and changes go to the platform activity log.
export const platformRouter = Router();
const ticketAudit = (action, details) =>
  audited(action, { targetType: 'SupportTicket', society: (_req, data) => data?.society, details: (req, data) => ({ number: data?.number, ...details(req, data) }) });
platformRouter.get('/support/stats', requirePlatform('support.view'), controller.stats);
platformRouter.get('/support/team', requirePlatform('support.view'), controller.team);
platformRouter.get('/support/tickets', requirePlatform('support.view'), validate({ query: schema.listAll }), controller.listAll);
platformRouter.get('/support/tickets/:id', requirePlatform('support.view'), validate({ params: schema.idParams }), controller.getAny);
platformRouter.post('/support/tickets/:id/messages', requirePlatform('support.reply'), validate({ params: schema.idParams, body: schema.platformReply }),
  ticketAudit('support.replied', (req) => ({ status: req.body.status })), controller.platformReply);
platformRouter.post('/support/tickets/:id/status', requirePlatform('support.reply'), validate({ params: schema.idParams, body: schema.setStatus }),
  ticketAudit('support.status_changed', (req) => req.body), controller.setStatus);
// Taking a ticket yourself only needs reply rights; handing it to someone else needs support.assign.
const assignGuard = (req, res, next) =>
  (!req.body?.assignedTo || String(req.body.assignedTo) === String(req.user._id) ? requirePlatform('support.reply') : requirePlatform('support.assign'))(req, res, next);
platformRouter.post('/support/tickets/:id/assign', assignGuard, validate({ params: schema.idParams, body: schema.assign }),
  ticketAudit('support.assigned', (_req, data) => ({ assignedTo: data?.assignedTo?.name })), controller.assign);
