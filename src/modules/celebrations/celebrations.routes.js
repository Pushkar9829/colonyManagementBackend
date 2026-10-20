import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './celebrations.controller.js';
import * as schema from './celebrations.validation.js';

// /api/v1/celebrations — birthday and anniversary wishes. Settings and the upcoming list are for society
// admins (authorize() = admin only); the opt-in "Today's birthdays" card is for every member.
const router = Router();
router.use(authenticate, requireSociety);

router.get('/today', controller.today);
router.get('/settings', authorize(), controller.getSettings);
router.put('/settings', authorize(), validate({ body: schema.updateSettings }), controller.updateSettings);
router.post('/preview', authorize(), validate({ body: schema.preview }), controller.preview);
router.get('/upcoming', authorize(), validate({ query: schema.upcomingQuery }), controller.upcoming);

export default router;
