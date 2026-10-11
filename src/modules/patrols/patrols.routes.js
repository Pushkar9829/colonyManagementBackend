import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './patrols.controller.js';
import * as schema from './patrols.validation.js';

const { GUARD, FACILITY_MANAGER } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

router.get('/checkpoints', authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.listCheckpoints }), controller.listCheckpoints);
router.post('/checkpoints', authorize(FACILITY_MANAGER), validate({ body: schema.createCheckpoint }), controller.createCheckpoint);
router.patch('/checkpoints/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.updateCheckpoint }), controller.updateCheckpoint);
router.delete('/checkpoints/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams }), controller.removeCheckpoint);

router.get('/routes', authorize(GUARD, FACILITY_MANAGER), controller.listRoutes);
router.post('/routes', authorize(FACILITY_MANAGER), validate({ body: schema.createRoute }), controller.createRoute);
router.patch('/routes/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.updateRoute }), controller.updateRoute);
router.delete('/routes/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams }), controller.removeRoute);

router.post('/scan', authorize(GUARD), validate({ body: schema.scan }), controller.scan);
router.get('/current', authorize(GUARD, FACILITY_MANAGER), controller.current);
router.get('/rounds', authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.listRounds }), controller.listRounds);
router.get('/scans', authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.listScans }), controller.listScans);
router.get('/report', authorize(FACILITY_MANAGER), validate({ query: schema.report }), controller.report);

export default router;
