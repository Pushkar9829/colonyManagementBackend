import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import { governanceOr, requireGovernance } from '../committee/committee.access.js';
import * as controller from './requests.controller.js';
import * as s from './requests.validation.js';

// Residents raise and follow their own requests (the service scopes reads to the requester);
// the committee decides; guards read the day's approved moves.
const router = Router();
router.use(authenticate, requireSociety);
const gov = requireGovernance;

router.get('/', validate({ query: s.listRequests }), controller.list);
router.post('/', authorize(ROLES.RESIDENT), validate({ body: s.createRequest }), controller.create);
router.get('/moves', governanceOr(ROLES.GUARD), validate({ query: s.movesQuery }), controller.moves);
router.get('/:id', validate({ params: s.idParams }), controller.getById);
router.get('/:id/letter/pdf', validate({ params: s.idParams }), controller.letterPdf);
router.post('/:id/comments', validate({ params: s.idParams, body: s.comment }), controller.addComment);
router.post('/:id/respond', authorize(ROLES.RESIDENT), validate({ params: s.idParams, body: s.respond }), controller.respond);
router.post('/:id/cancel', authorize(ROLES.RESIDENT), validate({ params: s.idParams }), controller.cancel);
router.post('/:id/request-info', gov, validate({ params: s.idParams, body: s.requestInfo }), controller.requestInfo);
router.post('/:id/approve', gov, validate({ params: s.idParams, body: s.approve }), controller.approve);
router.post('/:id/reject', gov, validate({ params: s.idParams, body: s.reject }), controller.reject);

export default router;
