import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import { governanceOr } from '../committee/committee.access.js';
import * as controller from './users.controller.js';
import * as schema from './users.validation.js';

const router = Router();
router.use(authenticate, requireSociety);

// Facility managers and accountants can look people up (assign tickets, chase dues); only admins change them.
// Committee office-bearers (often residents) also need the member list for registers and meeting invites.
const readers = governanceOr(ROLES.ADMIN, ROLES.FACILITY_MANAGER, ROLES.ACCOUNTANT);
router.get('/', readers, validate({ query: schema.listUsers }), controller.list);
router.post('/', authorize(), validate({ body: schema.createUser }), controller.create);
router.get('/:id', readers, validate({ params: schema.idParams }), controller.getById);
router.patch('/:id', authorize(), validate({ params: schema.idParams, body: schema.updateUser }), controller.update);
router.post('/:id/approve', authorize(), validate({ params: schema.idParams }), controller.approve);
router.post('/:id/reject', authorize(), validate({ params: schema.idParams }), controller.reject);
router.post('/:id/reset-password', authorize(), validate({ params: schema.idParams, body: schema.resetPassword }), controller.resetPassword);

export default router;
