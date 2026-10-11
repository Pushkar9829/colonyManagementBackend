import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './complaints.controller.js';
import * as schema from './complaints.validation.js';

const { RESIDENT, FACILITY_MANAGER, STAFF } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

router.get('/stats', authorize(FACILITY_MANAGER), controller.stats);

// Categories: everyone reads (create form); only the society admin edits (authorize() = admin only).
router.get('/categories', validate({ query: schema.categoryQuery }), controller.listCategories);
router.get('/categories/suggest', validate({ query: schema.suggestQuery }), controller.suggestCategory);
router.post('/categories', authorize(), validate({ body: schema.createCategory }), controller.createCategory);
router.patch('/categories/:key', authorize(), validate({ params: schema.categoryParams, body: schema.updateCategory }), controller.updateCategory);

// Escalation matrix and staff performance (managers).
router.get('/escalation-rules', authorize(FACILITY_MANAGER), controller.listRules);
router.post('/escalation-rules', authorize(FACILITY_MANAGER), validate({ body: schema.createRule }), controller.createRule);
router.patch('/escalation-rules/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.updateRule }), controller.updateRule);
router.delete('/escalation-rules/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams }), controller.deleteRule);
router.get('/reports/staff-performance', authorize(FACILITY_MANAGER), validate({ query: schema.performanceQuery }), controller.staffPerformance);
router.get('/', authorize(RESIDENT, FACILITY_MANAGER, STAFF), validate({ query: schema.listComplaints }), controller.list);
router.post('/', authorize(RESIDENT, FACILITY_MANAGER), validate({ body: schema.createComplaint }), controller.create);
router.get('/:id', authorize(RESIDENT, FACILITY_MANAGER, STAFF), validate({ params: schema.idParams }), controller.getById);
router.post('/:id/assign', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.assign }), controller.assign);
router.post('/:id/status', authorize(FACILITY_MANAGER, STAFF), validate({ params: schema.idParams, body: schema.changeStatus }), controller.changeStatus);
router.post('/:id/comments', authorize(RESIDENT, FACILITY_MANAGER, STAFF), validate({ params: schema.idParams, body: schema.comment }), controller.addComment);
router.post('/:id/reopen', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.reopen }), controller.reopen);
router.post('/:id/rate', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.rate }), controller.rate);

export default router;
