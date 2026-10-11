import { Router } from 'express';
import { authenticate } from '../../common/middleware/auth.js';
import * as controller from './portfolio.controller.js';

// /api/v1/portfolio — across every society the caller manages, so no requireSociety:
// scope comes from the caller's own admin / facility-manager memberships, never from the client.
const router = Router();
router.get('/', authenticate, controller.overview);

export default router;
