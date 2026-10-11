import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './lostFound.controller.js';
import * as schema from './lostFound.validation.js';

const COMMUNITY = [ROLES.RESIDENT, ROLES.FACILITY_MANAGER, ROLES.ACCOUNTANT];
const router = Router();
router.use(authenticate, requireSociety, authorize(...COMMUNITY));

router.get('/', validate({ query: schema.listItems }), controller.list);
router.post('/', validate({ body: schema.createItem }), controller.create);
router.get('/:id', validate({ params: schema.idParams }), controller.getById);
router.patch('/:id', validate({ params: schema.idParams, body: schema.updateItem }), controller.update);
router.delete('/:id', validate({ params: schema.idParams }), controller.remove);
router.post('/:id/status', validate({ params: schema.idParams, body: schema.close }), controller.close);
router.post('/:id/claims', validate({ params: schema.idParams, body: schema.claim }), controller.claim);
router.delete('/:id/claims/mine', validate({ params: schema.idParams }), controller.withdrawClaim);
router.post('/:id/claims/:claimId/accept', validate({ params: schema.claimParams }), controller.acceptClaim);
router.post('/:id/claims/:claimId/reject', validate({ params: schema.claimParams }), controller.rejectClaim);

export default router;
