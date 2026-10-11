import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './emergency.controller.js';
import * as schema from './emergency.validation.js';

const { GUARD, RESIDENT, FACILITY_MANAGER } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);
const id = { params: schema.idParams };

// directory: every member can read it
router.get('/contacts', validate({ query: schema.listContacts }), controller.listContacts);
router.post('/contacts', authorize(FACILITY_MANAGER), validate({ body: schema.createContact }), controller.createContact);
router.post('/contacts/reorder', authorize(FACILITY_MANAGER), validate({ body: schema.reorder }), controller.reorderContacts);
router.patch('/contacts/:id', authorize(FACILITY_MANAGER), validate({ ...id, body: schema.updateContact }), controller.updateContact);
router.delete('/contacts/:id', authorize(FACILITY_MANAGER), validate(id), controller.removeContact);

// child safety
router.get('/children', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listChildren }), controller.listChildren);
router.post('/children', authorize(RESIDENT), validate({ body: schema.createChild }), controller.createChild);
router.patch('/children/:id', authorize(RESIDENT), validate({ ...id, body: schema.updateChild }), controller.updateChild);
router.delete('/children/:id', authorize(RESIDENT), validate(id), controller.removeChild);
router.post('/children/:id/exit-alert', authorize(GUARD), validate({ ...id, body: schema.exitAlert }), controller.raiseExit);

router.get('/child-alerts', authorize(RESIDENT, GUARD, FACILITY_MANAGER), validate({ query: schema.listAlerts }), controller.listAlerts);
router.post('/child-alerts/:id/acknowledge', authorize(RESIDENT), validate({ ...id, body: schema.acknowledge }), controller.acknowledge);

export default router;
