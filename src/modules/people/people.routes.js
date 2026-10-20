import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './people.controller.js';
import * as schema from './people.validation.js';

// /api/v1/people — personal details (birthday, anniversary, gender, occupation).
// Every member edits their own; family members without a login are edited from My household
// (/household/me/members); society admins (authorize() = admin only) edit anyone in the society.
const router = Router();
router.use(authenticate, requireSociety);

router.get('/options', controller.options);
router.get('/me', controller.getMine);
router.put('/me', validate({ body: schema.personalBody }), controller.updateMine);

router.get('/units/:unitId', authorize(), validate({ params: schema.unitParams }), controller.forUnit);
router.put('/users/:userId', authorize(), validate({ params: schema.userParams, body: schema.personalBody }), controller.updateForUser);
router.put('/units/:unitId/family/:memberId', authorize(), validate({ params: schema.familyParams, body: schema.familyPersonalBody }), controller.updateForFamilyMember);

export default router;
