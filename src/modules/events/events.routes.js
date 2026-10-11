import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import env from '../../config/env.js';
import * as controller from './events.controller.js';
import * as schema from './events.validation.js';

const { RESIDENT, FACILITY_MANAGER, ACCOUNTANT } = ROLES;
const router = Router();
// Everyone in the society can view events (audience-filtered); residents RSVP; admin/FM organise.
router.use(authenticate, requireSociety);

const organiser = authorize(FACILITY_MANAGER);
const attendee = authorize(RESIDENT);
const id = { params: schema.idParams };

router.post('/payments/verify', attendee, validate({ body: schema.verify }), controller.verify);
if (env.PAYMENT_PROVIDER === 'mock') {
  router.post('/payments/mock/sign', attendee, validate({ body: schema.mockSign }), controller.mockSign);
}

router.get('/', validate({ query: schema.listEvents }), controller.list);
router.post('/', organiser, validate({ body: schema.createEvent }), controller.create);
router.get('/:id', validate(id), controller.getById);
router.patch('/:id', organiser, validate({ ...id, body: schema.updateEvent }), controller.update);
router.post('/:id/cancel', organiser, validate({ ...id, body: schema.cancelEvent }), controller.cancel);

router.post('/:id/rsvp', attendee, validate({ ...id, body: schema.rsvp }), controller.rsvp);
router.delete('/:id/rsvp', attendee, validate(id), controller.cancelRsvp);
router.get('/:id/ticket', attendee, validate(id), controller.myTicket);
router.post('/:id/pay', attendee, validate(id), controller.createOrder);

router.get('/:id/rsvps', organiser, validate({ ...id, query: schema.listRsvps }), controller.listRsvps);
router.get('/:id/tickets', authorize(FACILITY_MANAGER, ACCOUNTANT), validate({ ...id, query: schema.listRsvps }), controller.listTickets);
router.post('/:id/rsvps/:rsvpId/collect', organiser, validate({ params: schema.rsvpParams, body: schema.collect }), controller.collect);
router.post('/:id/check-in', organiser, validate({ ...id, body: schema.checkIn }), controller.checkIn);
router.delete('/:id/check-in/:rsvpId', organiser, validate({ params: schema.rsvpParams }), controller.undoCheckIn);

router.post('/:id/photos', authorize(RESIDENT, FACILITY_MANAGER), validate({ ...id, body: schema.photos }), controller.addPhotos);
router.delete('/:id/photos/:photoId', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.photoParams }), controller.removePhoto);

export default router;
