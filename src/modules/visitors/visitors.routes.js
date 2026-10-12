import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './visitors.controller.js';
import * as schema from './visitors.validation.js';

const { GUARD, RESIDENT, FACILITY_MANAGER } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

// Static paths are declared before the /:id routes.

// passes
router.get('/passes', authorize(RESIDENT, GUARD), validate({ query: schema.listPasses }), controller.listPasses);
router.post('/passes', authorize(RESIDENT), validate({ body: schema.createPass }), controller.createPass);
router.post('/passes/verify', authorize(GUARD), validate({ body: schema.verifyPass }), controller.verifyPass);
router.post('/passes/:id/cancel', authorize(RESIDENT), validate({ params: schema.idParams }), controller.cancelPass);

// blocklist / watchlist: management maintains it, guards can see and pre-check
router.get('/watchlist', authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.listWatch }), controller.listWatch);
router.post('/watchlist', authorize(FACILITY_MANAGER), validate({ body: schema.createWatch }), controller.createWatch);
router.post('/watchlist/check', authorize(GUARD, FACILITY_MANAGER), validate({ body: schema.checkWatch }), controller.checkWatch);
router.patch('/watchlist/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.updateWatch }), controller.updateWatch);
router.delete('/watchlist/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams }), controller.removeWatch);

// frequent visitors per household (guards may look them up by unit)
router.get('/frequent', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listFrequent }), controller.listFrequent);
router.post('/frequent', authorize(RESIDENT), validate({ body: schema.createFrequent }), controller.createFrequent);
router.patch('/frequent/:id', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.updateFrequent }), controller.updateFrequent);
router.delete('/frequent/:id', authorize(RESIDENT), validate({ params: schema.idParams }), controller.removeFrequent);
router.post('/frequent/:id/pass', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.frequentPass }), controller.frequentPass);

// offline gate queue replay
router.post('/sync', authorize(GUARD), validate({ body: schema.sync }), controller.sync);

// analytics & settings
router.get('/analytics', authorize(FACILITY_MANAGER), validate({ query: schema.analytics }), controller.analyticsSummary);
router.get('/analytics/export', authorize(FACILITY_MANAGER), validate({ query: schema.analytics }), controller.analyticsExport);
router.get('/security-settings', authorize(GUARD, FACILITY_MANAGER), controller.getSettings);
router.patch('/security-settings', authorize(), validate({ body: schema.settings }), controller.updateSettings);

// gate entries
router.get('/', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listVisitors }), controller.list);
router.post('/', authorize(GUARD), validate({ body: schema.logEntry }), controller.logEntry);
router.post('/:id/approve', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.respond }), controller.approve);
router.post('/:id/deny', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.respond }), controller.deny);
router.post('/:id/check-in', authorize(GUARD), validate({ params: schema.idParams, body: schema.respond }), controller.guardCheckIn);
router.post('/:id/send-back', authorize(GUARD), validate({ params: schema.idParams, body: schema.respond }), controller.guardSendBack);
router.post('/:id/check-out', authorize(GUARD), validate({ params: schema.idParams, body: schema.checkOut }), controller.checkOut);
router.get('/:id/contacts', authorize(GUARD), validate({ params: schema.idParams }), controller.contacts);

export default router;
