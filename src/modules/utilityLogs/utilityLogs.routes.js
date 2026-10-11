import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as c from './utilityLogs.controller.js';
import * as schema from './utilityLogs.validation.js';

const { FACILITY_MANAGER: FM, STAFF, GUARD } = ROLES;

// Shift readings (DG, tanks, STP/WTP, meters, pumps). Technicians and guards log; managers configure and report.
const router = Router();
router.use(authenticate, requireSociety);

router.get('/points', authorize(FM, STAFF, GUARD), validate({ query: schema.listPoints }), c.listPoints);
router.post('/points', authorize(FM), validate({ body: schema.createPoint }), c.createPoint);
router.patch('/points/:id', authorize(FM), validate({ params: schema.idParams, body: schema.updatePoint }), c.updatePoint);
router.get('/readings', authorize(FM, STAFF, GUARD), validate({ query: schema.listReadings }), c.listReadings);
router.post('/readings', authorize(FM, STAFF, GUARD), validate({ body: schema.createReading }), c.createReading);
router.get('/summary', authorize(FM), validate({ query: schema.summaryQuery }), c.summary);
router.get('/export', authorize(FM), validate({ query: schema.exportQuery }), c.exportXlsx);

export default router;
