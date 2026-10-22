import { Router } from 'express';
import { authenticate, authorize, requirePlatform, requirePlatformAny, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { audited } from '../platformTeam/platformAudit.js';
import * as controller from './appearance.controller.js';
import * as schema from './appearance.validation.js';

// /api/v1/appearance — the colony's app template. /public is for the login page (no token).
const router = Router();
router.get('/public', validate({ query: schema.publicQuery }), controller.publicAppearance);
router.use(authenticate, requireSociety);
router.get('/', controller.mine);
// Settings → Appearance: society admins only (authorize() with no roles = admin).
router.get('/options', authorize(), controller.options);
router.get('/preview/:key', authorize(), validate({ params: schema.keyParams }), controller.preview);
router.put('/template', authorize(), validate({ body: schema.apply }), controller.apply);
router.patch('/media', authorize(), validate({ body: schema.media }), controller.setMedia);

export default router;

// /api/v1/platform/templates — the platform console. Every change lands in the platform activity log.
const tpl = { targetType: 'Template', targetId: () => undefined, details: (req) => ({ ...req.params, ...req.body }) };
export const platformRouter = Router();
platformRouter.use(authenticate);
platformRouter.get('/', requirePlatform('templates.manage'), controller.overview);
platformRouter.put('/default', requirePlatform('templates.manage'), validate({ body: schema.setDefault }), audited('template.default_set', tpl), controller.setDefault);
platformRouter.put('/plans/:plan', requirePlatform('templates.manage'), validate({ params: schema.planParams, body: schema.setPlanRule }), audited('template.plan_rule_changed', tpl), controller.setPlanRule);
platformRouter.get('/societies/:id', requirePlatformAny('templates.manage', 'societies.view'), validate({ params: schema.idParams }), controller.societyGet);
platformRouter.patch('/societies/:id', requirePlatform('templates.manage'), validate({ params: schema.idParams, body: schema.updateSociety }),
  audited((req) => (req.body.forceTemplate ? 'society.template_forced' : 'society.appearance_changed'), { targetType: 'Society' }), controller.societyUpdate);
platformRouter.get('/resellers/:id', requirePlatformAny('templates.manage', 'whitelabel.manage'), validate({ params: schema.idParams }), controller.resellerGet);
platformRouter.patch('/resellers/:id', requirePlatform('templates.manage'), validate({ params: schema.idParams, body: schema.updateReseller }),
  audited('reseller.templates_changed', { targetType: 'Reseller' }), controller.resellerUpdate);
platformRouter.patch('/:key', requirePlatform('templates.manage'), validate({ params: schema.keyParams, body: schema.setEnabled }),
  audited((req) => (req.body.enabled ? 'template.enabled' : 'template.disabled'), tpl), controller.setEnabled);
