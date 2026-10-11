import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './guardDuty.controller.js';
import * as schema from './guardDuty.validation.js';

const { GUARD, FACILITY_MANAGER } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

router.get('/guards', authorize(GUARD, FACILITY_MANAGER), controller.guards);
router.get('/handovers', authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.listHandovers }), controller.listHandovers);
router.post('/handovers', authorize(GUARD), validate({ body: schema.createHandover }), controller.createHandover);
router.post('/handovers/:id/acknowledge', authorize(GUARD), validate({ params: schema.idParams, body: schema.acknowledge }), controller.acknowledgeHandover);

router.get('/incidents', authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.listIncidents }), controller.listIncidents);
router.post('/incidents', authorize(GUARD, FACILITY_MANAGER), validate({ body: schema.createIncident }), controller.createIncident);
router.get('/incidents/:id', authorize(GUARD, FACILITY_MANAGER), validate({ params: schema.idParams }), controller.getIncident);
router.post('/incidents/:id/close', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.closeIncident }), controller.closeIncident);

router.get('/occurrence-book', authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.occurrenceBook }), controller.occurrenceBook);
router.post('/occurrence-book', authorize(GUARD, FACILITY_MANAGER), validate({ body: schema.addOccurrence }), controller.addOccurrence);

export default router;
