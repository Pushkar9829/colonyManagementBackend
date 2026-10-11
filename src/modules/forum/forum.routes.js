import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './forum.controller.js';
import * as schema from './forum.validation.js';

const { RESIDENT, FACILITY_MANAGER, ACCOUNTANT } = ROLES;
const router = Router();
router.use(authenticate, requireSociety, authorize(RESIDENT, FACILITY_MANAGER, ACCOUNTANT));

// admin + facility manager moderate
const moderator = authorize(FACILITY_MANAGER);
const id = { params: schema.idParams };

router.get('/categories', validate({ query: schema.listCategories }), controller.listCategories);
router.post('/categories', moderator, validate({ body: schema.createCategory }), controller.createCategory);
router.patch('/categories/:id', moderator, validate({ ...id, body: schema.updateCategory }), controller.updateCategory);

router.get('/mentionable', validate({ query: schema.mentionable }), controller.mentionable);

router.get('/reports', moderator, validate({ query: schema.listReports }), controller.listReports);
router.post('/reports', validate({ body: schema.report }), controller.report);
router.post('/reports/resolve', moderator, validate({ body: schema.resolveReports }), controller.resolveReports);

router.get('/topics', validate({ query: schema.listTopics }), controller.listTopics);
router.post('/topics', validate({ body: schema.createTopic }), controller.createTopic);
router.get('/topics/:id', validate({ ...id, query: schema.topicQuery }), controller.getTopic);
router.patch('/topics/:id', validate({ ...id, body: schema.updateTopic }), controller.updateTopic);
router.delete('/topics/:id', validate({ ...id, body: schema.removeBody }), controller.deleteTopic);
router.post('/topics/:id/like', validate(id), controller.likeTopic);
router.post('/topics/:id/resolve', validate({ ...id, body: schema.resolved }), controller.setResolved);
router.post('/topics/:id/pin', moderator, validate({ ...id, body: schema.flag }), controller.pin);
router.post('/topics/:id/lock', moderator, validate({ ...id, body: schema.flag }), controller.lock);
router.post('/topics/:id/replies', validate({ ...id, body: schema.reply }), controller.addReply);

router.patch('/replies/:id', validate({ ...id, body: schema.updateReply }), controller.updateReply);
router.delete('/replies/:id', validate({ ...id, body: schema.removeBody }), controller.deleteReply);
router.post('/replies/:id/like', validate(id), controller.likeReply);

export default router;
