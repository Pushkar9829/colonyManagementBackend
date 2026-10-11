import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './tenancy.controller.js';
import * as schema from './tenancy.validation.js';

const { RESIDENT, FACILITY_MANAGER } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

// Residents only ever get their own lease (tenant) or their flat's leases (owner) — filtered in the service.
router.get('/', authorize(RESIDENT, FACILITY_MANAGER), validate({ query: schema.listLeases }), controller.list);
router.post('/', authorize(FACILITY_MANAGER), validate({ body: schema.createLease }), controller.create);
router.get('/units/:unitId/history', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.unitParams }), controller.history);
router.get('/:id', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.idParams }), controller.getById);
router.patch('/:id', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.updateLease }), controller.update);
router.post('/:id/documents', authorize(RESIDENT, FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.addDocuments }), controller.addDocuments);
router.post('/:id/end', authorize(FACILITY_MANAGER), validate({ params: schema.idParams, body: schema.endLease }), controller.end);

export default router;
