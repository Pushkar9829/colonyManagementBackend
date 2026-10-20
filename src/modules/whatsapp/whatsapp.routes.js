import { Router } from 'express';
import { authenticate, requirePlatform, requirePlatformAdmin, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { audited } from '../platformTeam/platformAudit.js';
import * as controller from './whatsapp.controller.js';
import * as schema from './whatsapp.validation.js';

// /api/v1/whatsapp — the open society's WhatsApp mode (everyone) and credits (admin / accountant).
// Read-only: only the platform team changes the mode or adds credits.
const router = Router();
router.use(authenticate, requireSociety);
router.get('/', controller.mine);

export default router;

// Mounted at /api/v1/platform after the platform console router. It repeats the platform check itself so
// it stays closed even if the mount order changes.
export const platformRouter = Router();
platformRouter.use('/societies/:id/whatsapp', authenticate, requirePlatformAdmin, requirePlatform('whatsapp.manage'));
platformRouter.get('/societies/:id/whatsapp', validate({ params: schema.idParams }), controller.platformSummary);
platformRouter.patch('/societies/:id/whatsapp', validate({ params: schema.idParams, body: schema.updateAccount }),
  audited('whatsapp.settings_changed', { targetType: 'Society' }), controller.updateAccount);
platformRouter.post('/societies/:id/whatsapp/credits', validate({ params: schema.idParams, body: schema.grantCredits }),
  audited('whatsapp.credits_added', { targetType: 'Society' }), controller.grantCredits);
platformRouter.get('/societies/:id/whatsapp/ledger', validate({ params: schema.idParams, query: schema.ledgerQuery }), controller.ledger);
