import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './audit.controller.js';
import { listQuery } from './audit.validation.js';

const router = Router();

router.get('/', authenticate, authorize(), validate({ query: listQuery }), controller.list);

export default router;
