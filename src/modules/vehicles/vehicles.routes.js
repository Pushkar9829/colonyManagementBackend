import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './vehicles.controller.js';
import * as schema from './vehicles.validation.js';

const { RESIDENT, GUARD, FACILITY_MANAGER } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

// gate movement log (declared before /:id routes)
router.get('/movements', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listMovements }), controller.listMovements);
router.post('/movements', authorize(GUARD, FACILITY_MANAGER), validate({ body: schema.logMovement }), controller.logMovement);
router.get('/lookup', authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.lookup }), controller.lookup);

router.get('/', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listVehicles }), controller.list);
router.post('/', authorize(RESIDENT), validate({ body: schema.createVehicle }), controller.create);
router.patch('/:id/rfid', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.setRfid }), controller.setRfid);
router.patch('/:id', authorize(RESIDENT), validate({ params: schema.idParams, body: schema.updateVehicle }), controller.update);
router.delete('/:id', authorize(RESIDENT), validate({ params: schema.idParams }), controller.remove);

export default router;
