import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './parking.controller.js';
import * as schema from './parking.validation.js';

const { GUARD, RESIDENT, FACILITY_MANAGER } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);
const id = { params: schema.idParams };

router.get('/summary', authorize(GUARD, FACILITY_MANAGER), controller.summary);
router.get('/my', authorize(RESIDENT), controller.mine);

router.get('/areas', authorize(GUARD, FACILITY_MANAGER), controller.listAreas);
router.post('/areas', authorize(FACILITY_MANAGER), validate({ body: schema.area }), controller.createArea);
router.patch('/areas/:id', authorize(FACILITY_MANAGER), validate({ ...id, body: schema.updateArea }), controller.updateArea);
router.delete('/areas/:id', authorize(FACILITY_MANAGER), validate(id), controller.removeArea);

router.get('/slots', authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.listSlots }), controller.listSlots);
router.post('/slots', authorize(FACILITY_MANAGER), validate({ body: schema.createSlots }), controller.createSlots);
router.patch('/slots/:id', authorize(FACILITY_MANAGER), validate({ ...id, body: schema.updateSlot }), controller.updateSlot);
router.delete('/slots/:id', authorize(FACILITY_MANAGER), validate(id), controller.removeSlot);
router.post('/slots/:id/allot', authorize(FACILITY_MANAGER), validate({ ...id, body: schema.allot }), controller.allot);
router.post('/slots/:id/release', authorize(FACILITY_MANAGER), validate(id), controller.release);

router.get('/visitor-sessions', authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.listVisitor }), controller.listVisitor);
router.post('/visitor-sessions', authorize(GUARD, FACILITY_MANAGER), validate({ body: schema.startVisitor }), controller.startVisitor);
router.post('/visitor-sessions/:id/end', authorize(GUARD, FACILITY_MANAGER), validate(id), controller.endVisitor);

router.get('/violations', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listViolations }), controller.listViolations);
router.post('/violations', authorize(GUARD, FACILITY_MANAGER), validate({ body: schema.reportViolation }), controller.reportViolation);
router.post('/violations/:id/dispute', authorize(RESIDENT), validate({ ...id, body: schema.dispute }), controller.dispute);
router.post('/violations/:id/resolve', authorize(FACILITY_MANAGER), validate({ ...id, body: schema.resolveViolation }), controller.resolveViolation);

router.get('/ev/chargers', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listChargers }), controller.listChargers);
router.post('/ev/chargers', authorize(FACILITY_MANAGER), validate({ body: schema.createCharger }), controller.createCharger);
router.patch('/ev/chargers/:id', authorize(FACILITY_MANAGER), validate({ ...id, body: schema.updateCharger }), controller.updateCharger);
router.get('/ev/chargers/:id/availability', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ ...id, query: schema.availability }), controller.availability);
router.get('/ev/bookings', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listBookings }), controller.listBookings);
router.post('/ev/bookings', authorize(RESIDENT, FACILITY_MANAGER), validate({ body: schema.book }), controller.book);
router.post('/ev/bookings/:id/start', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate(id), controller.start);
router.post('/ev/bookings/:id/complete', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ ...id, body: schema.complete }), controller.complete);
router.post('/ev/bookings/:id/cancel', authorize(RESIDENT, FACILITY_MANAGER), validate({ ...id, body: schema.cancel }), controller.cancel);

export default router;
