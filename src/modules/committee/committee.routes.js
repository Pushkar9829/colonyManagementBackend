import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './committee.controller.js';
import * as schema from './committee.validation.js';

const router = Router();
router.use(authenticate, requireSociety);

// Every member may see who is on the committee. Only the society admin seats a committee,
// so an office-bearer cannot appoint themselves to more authority.
router.get('/me', controller.me);
router.get('/current', controller.current);
router.get('/signatories', controller.signatories);
router.get('/terms', controller.listTerms);
router.post('/terms', authorize(), validate({ body: schema.createTerm }), controller.createTerm);
router.post('/terms/from-election', authorize(), validate({ body: schema.termFromElection }), controller.termFromElection);
router.patch('/terms/:id', authorize(), validate({ params: schema.idParams, body: schema.updateTerm }), controller.updateTerm);
router.post('/terms/:id/activate', authorize(), validate({ params: schema.idParams }), controller.activateTerm);
router.post('/terms/:id/dissolve', authorize(), validate({ params: schema.idParams }), controller.dissolveTerm);
router.post('/terms/:id/positions', authorize(), validate({ params: schema.idParams, body: schema.addPosition }), controller.addPosition);
router.patch('/terms/:id/positions/:positionId', authorize(), validate({ params: schema.positionParams, body: schema.updatePosition }), controller.updatePosition);
router.post('/terms/:id/positions/:positionId/end', authorize(), validate({ params: schema.positionParams, body: schema.endPosition }), controller.endPosition);
router.delete('/terms/:id/positions/:positionId', authorize(), validate({ params: schema.positionParams }), controller.removePosition);

export default router;
