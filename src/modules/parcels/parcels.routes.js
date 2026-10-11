import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './parcels.controller.js';
import * as schema from './parcels.validation.js';

const { GUARD, RESIDENT, FACILITY_MANAGER } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

// household delivery preferences ("leave at gate")
router.get('/preferences', authorize(RESIDENT), controller.listPreferences);
router.post('/preferences', authorize(RESIDENT), validate({ body: schema.createPreference }), controller.createPreference);
router.get('/preferences/check', authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.checkPreference }), controller.checkPreference);
router.delete('/preferences/:id', authorize(RESIDENT), validate({ params: schema.idParams }), controller.removePreference);

router.get('/stats', authorize(GUARD, FACILITY_MANAGER), controller.stats);
router.get('/', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listParcels }), controller.list);
router.post('/', authorize(GUARD), validate({ body: schema.createParcel }), controller.create);
router.get('/:id', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ params: schema.idParams }), controller.getById);
router.post('/:id/collect', authorize(GUARD), validate({ params: schema.idParams, body: schema.collect }), controller.collect);
router.post('/:id/return', authorize(GUARD, FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.markReturned }), controller.markReturned);
router.post('/:id/remind', authorize(GUARD, FACILITY_MANAGER), validate({ params: schema.idParams }), controller.remind);

export default router;
