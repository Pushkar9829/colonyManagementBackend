import { Router } from 'express';
import { authenticate, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './search.controller.js';
import * as schema from './search.validation.js';

// Every member may search; what each role gets back is decided per group in the service.
const router = Router();
router.use(authenticate, requireSociety);

router.get('/', validate({ query: schema.searchQuery }), controller.search);

export default router;
