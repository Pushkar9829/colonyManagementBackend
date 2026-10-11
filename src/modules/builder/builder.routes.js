import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import { requireFeature } from '../features/requireFeature.js';
import * as controller from './builder.controller.js';
import * as schema from './builder.validation.js';

const { RESIDENT, FACILITY_MANAGER, ACCOUNTANT, GUARD, STAFF } = ROLES;
const MEMBERS = [RESIDENT, FACILITY_MANAGER, ACCOUNTANT, GUARD, STAFF];

// /api/v1/builder — pre-handover projects. Builder staff are society admins (designation "Builder");
// buyers are residents and only see their own unit. Switched on per society with the 'builder' feature.
const router = Router();
router.use(authenticate, requireSociety, requireFeature('builder'));

router.get('/possessions', authorize(RESIDENT), validate({ query: schema.listPossessions }), controller.listPossessions);
router.post('/possessions', authorize(), validate({ body: schema.schedulePossession }), controller.schedulePossession);
router.patch('/possessions/:id', authorize(), validate({ params: schema.idParams, body: schema.updatePossession }), controller.updatePossession);
router.post('/possessions/:id/complete', authorize(), validate({ params: schema.idParams, body: schema.completePossession }), controller.completePossession);
router.post('/possessions/:id/cancel', authorize(), validate({ params: schema.idParams, body: schema.cancelPossession }), controller.cancelPossession);

router.get('/snags/summary', authorize(RESIDENT), controller.snagSummary);
router.get('/snags', authorize(RESIDENT), validate({ query: schema.listSnags }), controller.listSnags);
router.post('/snags', authorize(RESIDENT), validate({ body: schema.createSnag }), controller.createSnag);
router.get('/snags/:id', authorize(RESIDENT), validate({ params: schema.idParams }), controller.getSnag);
router.patch('/snags/:id', authorize(), validate({ params: schema.idParams, body: schema.updateSnag }), controller.updateSnag);
router.post('/snags/:id/sign-off', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.signOff }), controller.signOffSnag);
router.post('/snags/:id/reopen', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.reopenSnag }), controller.reopenSnag);

router.get('/progress', authorize(...MEMBERS), validate({ query: schema.listProgress }), controller.listProgress);
router.post('/progress', authorize(), validate({ body: schema.postProgress }), controller.postProgress);
router.delete('/progress/:id', authorize(), validate({ params: schema.idParams }), controller.removeProgress);

router.get('/handover', authorize(), controller.getHandover);
router.get('/handover/pdf', authorize(), controller.handoverPdf);
router.post('/handover/items', authorize(), validate({ body: schema.handoverItem }), controller.addHandoverItem);
router.patch('/handover/items/:itemId', authorize(), validate({ params: schema.itemParams, body: schema.updateHandoverItem }), controller.updateHandoverItem);
router.delete('/handover/items/:itemId', authorize(), validate({ params: schema.itemParams }), controller.removeHandoverItem);
router.post('/handover/sign', authorize(), validate({ body: schema.signHandover }), controller.signHandover);

export default router;
