import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './kyc.controller.js';
import * as schema from './kyc.validation.js';

// Strict access: a member sees only their own documents; reviewing is for society admins only
// (authorize() with no roles lets just the admin through), not facility managers.
const router = Router();
router.use(authenticate, requireSociety);

router.get('/me', controller.mine);
router.post('/', validate({ body: schema.submit }), controller.submit);
router.get('/completion', authorize(), validate({ query: schema.completionQuery }), controller.completion);
router.get('/', authorize(), validate({ query: schema.listDocs }), controller.list);
router.get('/:id', validate({ params: schema.idParams }), controller.getById);
router.delete('/:id', validate({ params: schema.idParams }), controller.removeMine);
router.post('/:id/verify', authorize(), validate({ params: schema.idParams }), controller.verify);
router.post('/:id/reject', authorize(), validate({ params: schema.idParams, body: schema.reject }), controller.reject);

export default router;
