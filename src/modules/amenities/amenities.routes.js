import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './amenities.controller.js';
import * as schema from './amenities.validation.js';

const { FACILITY_MANAGER, RESIDENT, GUARD } = ROLES;

export const amenityRouter = Router();
amenityRouter.use(authenticate, requireSociety);
amenityRouter.get('/', controller.listAmenities);
amenityRouter.post('/', authorize(FACILITY_MANAGER), validate({ body: schema.createAmenity }), controller.createAmenity);
amenityRouter.get('/reports/usage', authorize(FACILITY_MANAGER), validate({ query: schema.reportQuery }), controller.usageReport);
amenityRouter.get('/reports/usage.xlsx', authorize(FACILITY_MANAGER), validate({ query: schema.reportQuery }), controller.usageExport);
// Settles any amenity checkout (booking fee + deposit, or a pass).
amenityRouter.post('/payments/verify', authorize(RESIDENT), validate({ body: schema.verifyPayment }), controller.verifyPayment);
amenityRouter.get('/pass-plans', validate({ query: schema.planListQuery }), controller.listPlans);
amenityRouter.patch('/pass-plans/:planId', authorize(FACILITY_MANAGER), validate({ params: schema.planParams, body: schema.updatePlan }), controller.updatePlan);
amenityRouter.patch('/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.updateAmenity }), controller.updateAmenity);
amenityRouter.post('/:id/photos', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.photos }), controller.addPhotos);
amenityRouter.delete('/:id/photos/:photoId', authorize(FACILITY_MANAGER), validate({ params: schema.photoParams }), controller.removePhoto);
amenityRouter.get('/:id/availability', validate({ params: schema.idParams, query: schema.availabilityQuery }), controller.availability);
amenityRouter.get('/:id/pass-plans', validate({ params: schema.idParams }), controller.listPlans);
amenityRouter.post('/:id/pass-plans', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.createPlan }), controller.createPlan);

export const bookingRouter = Router();
bookingRouter.use(authenticate, requireSociety);
bookingRouter.get('/', authorize(RESIDENT, FACILITY_MANAGER), validate({ query: schema.listBookings }), controller.listBookings);
bookingRouter.post('/', authorize(RESIDENT), validate({ body: schema.createBooking }), controller.createBooking);
bookingRouter.get('/:id', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.idParams }), controller.getBooking);
bookingRouter.get('/:id/cancellation-quote', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.idParams }), controller.quote);
bookingRouter.post('/:id/cancel', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.cancel }), controller.cancelBooking);
bookingRouter.post('/:id/decide', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.decide }), controller.decide);
bookingRouter.post('/:id/pay', authorize(RESIDENT), validate({ params: schema.idParams }), controller.payBooking);
bookingRouter.post('/:id/mark-paid', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.markPaid }), controller.markBookingPaid);
bookingRouter.post('/:id/refund-deposit', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.refundDeposit }), controller.refundDeposit);
bookingRouter.post('/:id/attendance', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.attendance }), controller.markAttendance);

// Memberships / passes (gym, pool…). Guards and managers check them at the door.
export const passRouter = Router();
passRouter.use(authenticate, requireSociety);
passRouter.get('/', authorize(RESIDENT, FACILITY_MANAGER), validate({ query: schema.listPasses }), controller.listPasses);
passRouter.post('/', authorize(RESIDENT), validate({ body: schema.buyPass }), controller.buyPass);
passRouter.post('/check', authorize(GUARD, FACILITY_MANAGER), validate({ body: schema.checkPass }), controller.checkPass);
passRouter.get('/:id', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.idParams }), controller.getPass);
passRouter.post('/:id/pay', authorize(RESIDENT), validate({ params: schema.idParams }), controller.payPass);
passRouter.post('/:id/mark-paid', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.markPaid }), controller.markPassPaid);
passRouter.post('/:id/cancel', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.cancelPass }), controller.cancelPass);
