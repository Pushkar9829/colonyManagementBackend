import { Router } from 'express';
import { authenticate, authorize, requirePlatform, requirePlatformAny, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { authLimiter } from '../../common/middleware/rateLimit.js';
import { audited } from '../platformTeam/platformAudit.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './loginAs.controller.js';
import * as schema from './loginAs.validation.js';

const { ACCOUNTANT, FACILITY_MANAGER } = ROLES;
const router = Router();

// Exit takes the acting token even when it has expired (so the end is always recorded), hence no authenticate.
router.post('/exit', controller.exit);

router.use(authenticate);
// Asks for the caller's own password (and two-step code), so it shares the auth rate limit.
router.post('/', authLimiter, validate({ body: schema.start }), controller.start);
router.get('/current', controller.current);
router.get('/me/activity', controller.myActivity);

// Society side: what admins / sub-admins may do here (read-only) and the society's own session log.
router.get('/rules', requireSociety, authorize(ACCOUNTANT, FACILITY_MANAGER), controller.myRules);
router.get('/sessions', requireSociety, authorize(), validate({ query: schema.sessionsQuery }), controller.societySessions);

// Platform console.
const policyGuard = requirePlatformAny('team.manage', 'impersonation.manage');
router.get('/platform/policy', policyGuard, controller.getGlobalPolicy);
router.put('/platform/policy', policyGuard, validate({ body: schema.globalPolicy }), audited('login_as.policy_changed', { targetType: 'LoginAsPolicy' }), controller.setGlobalPolicy);
router.get('/platform/societies/:id/policy', policyGuard, validate({ params: schema.idParams }), controller.getSocietyPolicy);
router.put('/platform/societies/:id/policy', policyGuard, validate({ params: schema.idParams, body: schema.societyPolicy }), audited('login_as.society_policy_changed', { targetType: 'Society' }), controller.setSocietyPolicy);
router.get('/platform/sessions', requirePlatformAny('team.manage', 'impersonation.manage', 'audit.view'), validate({ query: schema.sessionsQuery }), controller.platformSessions);
router.get('/platform/societies/:id/members', requirePlatform('societies.view'), requirePlatformAny('support.access', 'impersonation.manage'), validate({ params: schema.idParams, query: schema.membersQuery }), controller.societyMembers);

export default router;
