import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './elections.controller.js';
import * as s from './elections.validation.js';

// Admins create elections; the admin or the election's returning officer runs it (checked in the service).
// Members nominate, accept nominations and vote; eligibility is checked per election.
const router = Router();
router.use(authenticate, requireSociety);

router.get('/', validate({ query: s.listElections }), controller.list);
router.post('/', authorize(), validate({ body: s.createElection }), controller.create);
router.get('/:id', validate({ params: s.idParams }), controller.getById);
router.patch('/:id', validate({ params: s.idParams, body: s.updateElection }), controller.update);
router.post('/:id/transition/:action', validate({ params: s.transitionParams, body: s.transitionBody }), controller.transition);
router.get('/:id/results', validate({ params: s.idParams }), controller.results);
router.post('/:id/resolve-tie', validate({ params: s.idParams, body: s.resolveTie }), controller.resolveTie);
router.post('/:id/publish', validate({ params: s.idParams }), controller.publish);
router.get('/:id/turnout', validate({ params: s.idParams }), controller.turnout);

router.get('/:id/nominations', validate({ params: s.idParams }), controller.listNominations);
router.get('/:id/candidates', validate({ params: s.idParams }), controller.eligibleCandidates);
router.post('/:id/nominations', validate({ params: s.idParams, body: s.nominate }), controller.nominate);
router.post('/:id/nominations/:nominationId/respond', validate({ params: s.nominationParams, body: s.respond }), controller.respond);
router.post('/:id/nominations/:nominationId/withdraw', validate({ params: s.nominationParams }), controller.withdraw);
router.post('/:id/nominations/:nominationId/scrutiny', validate({ params: s.nominationParams, body: s.scrutiny }), controller.scrutinize);

router.post('/:id/vote-code', validate({ params: s.idParams }), controller.voteCode);
router.post('/:id/vote', validate({ params: s.idParams, body: s.vote }), controller.vote);
router.get('/:id/verify', validate({ params: s.idParams, query: s.verify }), controller.verify);

export default router;
