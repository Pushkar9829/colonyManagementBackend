import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './household.controller.js';
import * as schema from './household.validation.js';

const { RESIDENT, FACILITY_MANAGER, GUARD } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

// Residents manage their own home's profile.
router.get('/me', authorize(RESIDENT), controller.getMine);
router.patch('/me', authorize(RESIDENT), validate({ body: schema.updateProfile }), controller.updateMine);
router.put('/me/medical', authorize(RESIDENT), validate({ body: schema.myMedical }), controller.setMyMedical);
for (const [list, body, update] of [['members', schema.memberBody, schema.memberUpdate], ['pets', schema.petBody, schema.petUpdate]]) {
  router.post(`/me/${list}`, authorize(RESIDENT), validate({ body }), controller.addItem(list));
  router.patch(`/me/${list}/:itemId`, authorize(RESIDENT), validate({ params: schema.itemParams, body: update }), controller.updateItem(list));
  router.delete(`/me/${list}/:itemId`, authorize(RESIDENT), validate({ params: schema.itemParams }), controller.removeItem(list));
}

// Responders: medical flags of the home that raised an open SOS (the only way guards see them).
router.get('/sos-context/:sosId', authorize(GUARD, FACILITY_MANAGER), validate({ params: schema.sosParams }), controller.sosContext);

// Managers view every home.
router.get('/', authorize(FACILITY_MANAGER), validate({ query: schema.listHouseholds }), controller.list);
router.get('/units/:unitId', authorize(FACILITY_MANAGER), validate({ params: schema.unitParams }), controller.getForUnit);

export default router;
