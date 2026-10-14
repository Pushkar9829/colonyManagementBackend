import { Router } from 'express';
import { authenticate, authorize, requirePlatform, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import { requireGovernance } from '../committee/committee.access.js';
import * as controller from './luckyDraw.controller.js';
import * as schema from './luckyDraw.validation.js';

// /api/v1/lucky-draws (gated on the 'luckyDraw' feature in routes.js).
// Every member can see published draws (the service hides drafts); residents enter; the managing committee
// (admins and sitting office-bearers, as for meetings) runs them.
const router = Router();
router.use(authenticate, requireSociety);

const manage = requireGovernance;
const resident = authorize(ROLES.RESIDENT); // the service also refuses admin-only logins
const id = { params: schema.idParams };
const winner = { params: schema.winnerParams };

router.get('/', validate({ query: schema.listDraws }), controller.list);
router.post('/', manage, validate({ body: schema.createDraw }), controller.create);
router.get('/:id', validate(id), controller.getById);
router.patch('/:id', manage, validate({ ...id, body: schema.updateDraw }), controller.update);
router.post('/:id/publish', manage, validate(id), controller.publish);
router.post('/:id/close', manage, validate(id), controller.close);
router.post('/:id/draw', manage, validate(id), controller.runDraw);
router.post('/:id/cancel', manage, validate({ ...id, body: schema.reason }), controller.cancel);
router.get('/:id/verify', validate(id), controller.verify);
router.get('/:id/entries', manage, validate({ ...id, query: schema.listEntries }), controller.listEntries);

router.post('/:id/entry', resident, validate(id), controller.enter);
router.delete('/:id/entry', resident, validate(id), controller.withdraw);

router.post('/:id/winners/:winnerId/promote', manage, validate({ ...winner, body: schema.reason }), controller.promoteReserve);
router.post('/:id/winners/:winnerId/handover', manage, validate({ ...winner, body: schema.handover }), controller.markHandedOver);

export default router;

// Mounted inside /api/v1/platform (already behind authenticate there). Platform team members need the
// 'luckydraw.oversee' permission.
const oversee = requirePlatform('luckydraw.oversee');
export const platformRouter = Router();
platformRouter.get('/lucky-draws', oversee, validate({ query: schema.platformList }), controller.listAll);
platformRouter.post('/lucky-draws/:id/cancel', oversee, validate({ ...id, body: schema.reason }), controller.platformCancel);
