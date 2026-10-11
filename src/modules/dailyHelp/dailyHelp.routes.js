import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { pageQuery } from '../../common/utils/schemas.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './dailyHelp.controller.js';
import * as schema from './dailyHelp.validation.js';

const { GUARD, RESIDENT, FACILITY_MANAGER } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

router.post('/gate-scan', authorize(GUARD), validate({ body: schema.gateScan }), controller.gateScan);
router.get('/', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listHelp }), controller.list);
router.post('/', authorize(RESIDENT, FACILITY_MANAGER), validate({ body: schema.createHelp }), controller.create);
router.patch('/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.updateHelp }), controller.update);
router.delete('/:id/my-unit', authorize(RESIDENT), validate({ params: schema.idParams }), controller.removeFromMyUnit);
router.get('/:id/attendance', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.idParams, query: pageQuery }), controller.attendance);
router.get('/:id', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ params: schema.idParams }), controller.getById);

// Ratings & reviews by the households the helper works for.
router.get('/:id/reviews', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.idParams, query: pageQuery }), controller.listReviews);
router.put('/:id/reviews/mine', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.reviewBody }), controller.review);
router.delete('/:id/reviews/mine', authorize(RESIDENT), validate({ params: schema.idParams }), controller.removeReview);

// A household's own salary arrangement and reminders.
router.put('/:id/employment', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.employment }), controller.setEmployment);
router.post('/:id/salary-paid', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.salaryPaid }), controller.markSalaryPaid);

// Leave / absence marking.
router.get('/:id/leaves', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.idParams, query: schema.leaveQuery }), controller.listLeaves);
router.post('/:id/leaves', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.leaveBody }), controller.addLeave);
router.delete('/:id/leaves/:leaveId', authorize(RESIDENT), validate({ params: schema.leaveParams }), controller.removeLeave);

// Documents and police verification.
router.post('/:id/documents', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.documentsBody }), controller.addDocuments);
router.post('/:id/verification', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.verificationBody }), controller.setVerification);

export default router;
