import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as c from './maintenance.controller.js';
import * as schema from './maintenance.validation.js';

const { FACILITY_MANAGER: FM, STAFF, GUARD } = ROLES;
const id = { params: schema.idParams };

// Preventive maintenance, breakdowns and housekeeping checklists. Staff/guards only see their own work
// (filtered in the services); managers see and plan everything.
export const maintenanceRouter = Router();
maintenanceRouter.use(authenticate, requireSociety);

maintenanceRouter.get('/stats', authorize(FM, STAFF, GUARD), c.stats);
maintenanceRouter.get('/schedules', authorize(FM), validate({ query: schema.listSchedules }), c.listSchedules);
maintenanceRouter.post('/schedules', authorize(FM), validate({ body: schema.createSchedule }), c.createSchedule);
maintenanceRouter.get('/schedules/:id', authorize(FM), validate(id), c.getSchedule);
maintenanceRouter.patch('/schedules/:id', authorize(FM), validate({ ...id, body: schema.updateSchedule }), c.updateSchedule);

maintenanceRouter.get('/tasks', authorize(FM, STAFF, GUARD), validate({ query: schema.listTasks }), c.listTasks);
maintenanceRouter.get('/tasks/:id', authorize(FM, STAFF, GUARD), validate(id), c.getTask);
maintenanceRouter.post('/tasks/:id/complete', authorize(FM, STAFF, GUARD), validate({ ...id, body: schema.completeTask }), c.completeTask);
maintenanceRouter.post('/tasks/:id/skip', authorize(FM), validate({ ...id, body: schema.skipTask }), c.skipTask);
maintenanceRouter.post('/tasks/:id/assign', authorize(FM), validate({ ...id, body: schema.reassignTask }), c.reassignTask);
maintenanceRouter.get('/reports/ppm', authorize(FM), validate({ query: schema.ppmReport }), c.ppmReport);

maintenanceRouter.get('/breakdowns', authorize(FM, STAFF), validate({ query: schema.listBreakdowns }), c.listBreakdowns);
maintenanceRouter.post('/breakdowns', authorize(FM, STAFF), validate({ body: schema.createBreakdown }), c.createBreakdown);
maintenanceRouter.get('/breakdowns/:id', authorize(FM, STAFF), validate(id), c.getBreakdown);
maintenanceRouter.post('/breakdowns/:id/assign', authorize(FM), validate({ ...id, body: schema.assignBreakdown }), c.assignBreakdown);
maintenanceRouter.post('/breakdowns/:id/status', authorize(FM, STAFF), validate({ ...id, body: schema.breakdownStatus }), c.breakdownStatus);

maintenanceRouter.get('/checklists', authorize(FM), c.listChecklists);
maintenanceRouter.post('/checklists', authorize(FM), validate({ body: schema.createChecklist }), c.createChecklist);
maintenanceRouter.patch('/checklists/:id', authorize(FM), validate({ ...id, body: schema.updateChecklist }), c.updateChecklist);
maintenanceRouter.get('/checklist-runs', authorize(FM, STAFF, GUARD), validate({ query: schema.listRuns }), c.listRuns);
maintenanceRouter.get('/checklist-runs/report', authorize(FM), validate({ query: schema.runReport }), c.runReport);
maintenanceRouter.post('/checklist-runs/:id/complete', authorize(FM, STAFF, GUARD), validate({ ...id, body: schema.completeRun }), c.completeRun);
maintenanceRouter.post('/checklist-runs/:id/verify', authorize(FM), validate({ ...id, body: schema.verifyRun }), c.verifyRun);

// Work orders for vendors / technicians.
export const workOrderRouter = Router();
workOrderRouter.use(authenticate, requireSociety);
workOrderRouter.get('/stats', authorize(FM), c.woStats);
workOrderRouter.get('/', authorize(FM, STAFF), validate({ query: schema.listWorkOrders }), c.listWorkOrders);
workOrderRouter.post('/', authorize(FM), validate({ body: schema.createWorkOrder }), c.createWorkOrder);
workOrderRouter.get('/:id', authorize(FM, STAFF), validate(id), c.getWorkOrder);
workOrderRouter.patch('/:id', authorize(FM), validate({ ...id, body: schema.updateWorkOrder }), c.updateWorkOrder);
workOrderRouter.post('/:id/status', authorize(FM, STAFF), validate({ ...id, body: schema.workOrderStatus }), c.workOrderStatus);
