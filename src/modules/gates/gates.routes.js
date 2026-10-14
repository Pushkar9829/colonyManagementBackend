import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ALL_ROLES, ROLES } from '../../common/constants/index.js';
import * as controller from './gates.controller.js';
import * as schema from './gates.validation.js';

const { GUARD, FACILITY_MANAGER } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

// Everyone in the society may see the open gates (residents pick them for guest passes);
// management also sees closed ones with ?includeInactive=true.
router.get('/', authorize(...ALL_ROLES), validate({ query: schema.listGates }), controller.list);
router.post('/', authorize(FACILITY_MANAGER), validate({ body: schema.createGate }), controller.create);
router.post('/reorder', authorize(FACILITY_MANAGER), validate({ body: schema.reorder }), controller.reorder);

// The gate the signed-in guard is working at.
router.get('/my-post', authorize(GUARD), controller.myPost);
router.put('/my-post', authorize(GUARD), validate({ body: schema.setPost }), controller.setPost);

router.patch('/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.updateGate }), controller.update);
// Deletes a gate nothing refers to; a gate with history is deactivated instead.
router.delete('/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams }), controller.remove);

export default router;
