import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './insights.controller.js';
import * as schema from './insights.validation.js';

const { RESIDENT, FACILITY_MANAGER, ACCOUNTANT } = ROLES;

// /api/v1/insights — rule-based helpers (heuristics, not ML; every response says so in `method`).
const router = Router();
router.use(authenticate, requireSociety);

router.post('/complaint-category', authorize(RESIDENT, FACILITY_MANAGER), validate({ body: schema.suggestCategory }), controller.suggestCategory);
router.get('/defaulter-risk', authorize(ACCOUNTANT), validate({ query: schema.riskQuery }), controller.defaulterRisk);
router.get('/defaulter-risk/:unitId', authorize(ACCOUNTANT), validate({ params: schema.unitParams }), controller.unitRisk);
router.get('/notice-templates', authorize(FACILITY_MANAGER), controller.listTemplates);
router.post('/notice-templates/:key', authorize(FACILITY_MANAGER), validate({ params: schema.templateParams, body: schema.renderTemplate }), controller.renderTemplate);
router.get('/health', authorize(), validate({ query: schema.healthQuery }), controller.health);

export default router;
