import { Router } from 'express';
import { authenticate, requirePlatform, requirePlatformAdmin } from '../../common/middleware/auth.js';
import { audited } from '../platformTeam/platformAudit.js';
import { platformRouter as teamRoutes } from '../platformTeam/platformTeam.routes.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './platform.controller.js';
import * as schema from './platform.validation.js';
import { platformRouter as subscriptionRoutes } from '../subscriptions/subscriptions.routes.js';
import { platformRouter as supportRoutes } from '../support/support.routes.js';
import { platformRouter as featureRoutes } from '../features/features.routes.js';
import { platformRouter as luckyDrawRoutes } from '../luckyDraw/luckyDraw.routes.js';

// SaaS owner console. Society admins never reach these routes. Every platform team member passes the
// router-level check; each route then requires its own permission (modules/platformTeam/permissions.js).
const router = Router();
router.use(authenticate, requirePlatformAdmin);

// One PATCH carries both kinds of change: switching a society on/off needs societies.suspend,
// anything else (plan, validity, unit limit, notes) needs societies.edit.
const SUSPEND_FIELDS = ['active', 'suspendedReason'];
const societyEditGuard = (req, res, next) => {
  const keys = Object.keys(req.body || {});
  const perms = [];
  if (keys.some((k) => SUSPEND_FIELDS.includes(k))) perms.push('societies.suspend');
  if (!perms.length || keys.some((k) => !SUSPEND_FIELDS.includes(k))) perms.push('societies.edit');
  return requirePlatform(...perms)(req, res, next);
};
const societyAction = (req) => (req.body.active === false ? 'society.suspended' : req.body.active === true ? 'society.reactivated' : 'society.updated');

router.get('/stats', requirePlatform('societies.view'), controller.stats);
router.get('/jobs', requirePlatform('jobs.view'), controller.jobs);
router.get('/societies', requirePlatform('societies.view'), validate({ query: schema.listSocieties }), controller.listSocieties);
router.get('/societies/:id', requirePlatform('societies.view'), validate({ params: schema.idParams }), controller.getSociety);
router.patch('/societies/:id', societyEditGuard, validate({ params: schema.idParams, body: schema.updateSociety }), audited(societyAction, { targetType: 'Society' }), controller.updateSociety);

// Platform team: members, roles, permission catalogue and the activity log.
router.use(teamRoutes);

// Platform-side endpoints of the subscription, support and feature-flag modules.
router.use(subscriptionRoutes);
router.use(supportRoutes);
router.use(featureRoutes);
router.use(luckyDrawRoutes);

export default router;
