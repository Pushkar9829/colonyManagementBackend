import { Router } from 'express';
import { authenticate, requirePlatformAdmin } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './platform.controller.js';
import * as schema from './platform.validation.js';
import { platformRouter as subscriptionRoutes } from '../subscriptions/subscriptions.routes.js';
import { platformRouter as supportRoutes } from '../support/support.routes.js';
import { platformRouter as featureRoutes } from '../features/features.routes.js';

// SaaS owner console. Society admins never reach these routes.
const router = Router();
router.use(authenticate, requirePlatformAdmin);

router.get('/stats', controller.stats);
router.get('/jobs', controller.jobs);
router.get('/societies', validate({ query: schema.listSocieties }), controller.listSocieties);
router.get('/societies/:id', validate({ params: schema.idParams }), controller.getSociety);
router.patch('/societies/:id', validate({ params: schema.idParams, body: schema.updateSociety }), controller.updateSociety);

// Platform-side endpoints of the subscription, support and feature-flag modules.
router.use(subscriptionRoutes);
router.use(supportRoutes);
router.use(featureRoutes);

export default router;
