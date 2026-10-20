import { Router } from 'express';
import { authenticate, authorize, requirePlatform, requirePlatformAny, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { audited } from '../platformTeam/platformAudit.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './paymentSettings.controller.js';
import * as schema from './paymentSettings.validation.js';

// /api/v1/payment-settings — how residents' online payments reach this society. Admin only, except the
// status (every member: decides whether "Pay online" is shown).
const router = Router();
router.use(authenticate, requireSociety);

router.get('/status', controller.status);
router.get('/', authorize(ROLES.ACCOUNTANT), controller.view);
router.put('/mode', authorize(), validate({ body: schema.chooseMode }), controller.chooseMode);
router.put('/own', authorize(), validate({ body: schema.ownKeys }), controller.saveOwnKeys);
router.post('/own/test', authorize(), controller.testConnection);
router.post('/test-payment', authorize(), controller.startTestPayment);
router.post('/test-payment/verify', authorize(), validate({ body: schema.verifyTest }), controller.verifyTestPayment);
router.post('/enable', authorize(), controller.enable);
router.post('/disable', authorize(), controller.disable);

export default router;

// Mounted at /api/v1/platform/payment-settings (behind the platform router's own checks too).
export const platformRouter = Router();
platformRouter.use(authenticate, requirePlatform());
const target = { targetType: 'Society', targetId: (req) => req.params.societyId, society: (req) => req.params.societyId };
platformRouter.get('/:societyId', requirePlatformAny('societies.view', 'payments.manage'), validate({ params: schema.societyParams }), controller.platformView);
platformRouter.patch('/:societyId', requirePlatform('payments.manage'), validate({ params: schema.societyParams, body: schema.platformUpdate }),
  audited((req) => (req.body.forceDisabled === true ? 'payments.force_disabled' : 'payments.settings_updated'), target), controller.platformUpdate);
platformRouter.post('/:societyId/route/refresh', requirePlatform('payments.manage'), validate({ params: schema.societyParams }),
  audited('payments.route_refreshed', target), controller.refreshRoute);
