import { Router } from 'express';
import { authenticate, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './chat.controller.js';
import * as schema from './chat.validation.js';

// Every member of the society can chat; who may talk to whom is enforced in the service.
const router = Router();
router.use(authenticate, requireSociety);

router.get('/unread', controller.unread);
router.get('/contacts', validate({ query: schema.contacts }), controller.contacts);
router.get('/blocks', controller.listBlocks);
router.post('/blocks', validate({ body: schema.blockBody }), controller.block);
router.delete('/blocks/:userId', validate({ params: schema.userParams }), controller.unblock);

router.get('/conversations', validate({ query: schema.listConversations }), controller.listConversations);
router.post('/conversations', validate({ body: schema.openDirect }), controller.openDirect);
router.post('/desk', validate({ body: schema.openDesk }), controller.openDesk);
router.get('/conversations/:id', validate({ params: schema.idParams }), controller.getConversation);
router.get('/conversations/:id/messages', validate({ params: schema.idParams, query: schema.listMessages }), controller.listMessages);
router.post('/conversations/:id/messages', validate({ params: schema.idParams, body: schema.sendMessage }), controller.sendMessage);
router.post('/conversations/:id/read', validate({ params: schema.idParams }), controller.markRead);
router.post('/conversations/:id/typing', validate({ params: schema.idParams }), controller.typing);

export default router;
