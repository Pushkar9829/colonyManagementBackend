import { Router } from 'express';
import { authenticate, requireSociety } from '../../common/middleware/auth.js';
import * as controller from './dashboard.controller.js';

const router = Router();

router.get('/', authenticate, requireSociety, controller.get);

export default router;
