import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './reports.controller.js';
import * as schema from './reports.validation.js';

const { ACCOUNTANT, FACILITY_MANAGER } = ROLES;

// /api/v1/reports — exports center. Each report also checks its own roles (finance vs operations).
const router = Router();
router.use(authenticate, requireSociety);

router.get('/', authorize(ACCOUNTANT, FACILITY_MANAGER), controller.catalogue);
router.get('/schedules', authorize(), controller.listSchedules);
router.get('/schedules/preview', authorize(), validate({ query: schema.previewQuery }), controller.preview);
router.post('/schedules', authorize(), validate({ body: schema.createSchedule }), controller.createSchedule);
router.patch('/schedules/:id', authorize(), validate({ params: schema.idParams, body: schema.updateSchedule }), controller.updateSchedule);
router.delete('/schedules/:id', authorize(), validate({ params: schema.idParams }), controller.removeSchedule);
router.post('/schedules/:id/send', authorize(), validate({ params: schema.idParams }), controller.sendNow);
router.get('/:key/export', authorize(ACCOUNTANT, FACILITY_MANAGER), validate({ params: schema.reportParams, query: schema.exportQuery }), controller.exportReport);

export default router;
