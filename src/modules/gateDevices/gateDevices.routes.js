import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { authenticateDevice } from '../../common/middleware/device.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './gateDevices.controller.js';
import * as schema from './gateDevices.validation.js';

const { GUARD, FACILITY_MANAGER } = ROLES;
const router = Router();
const user = [authenticate, requireSociety];

// ---- hardware (X-Device-Key) ----
router.post('/events', authenticateDevice('gate:events'), validate({ body: schema.event }), controller.event);
router.get('/commands', authenticateDevice('gate:commands'), validate({ query: schema.poll }), controller.poll);
router.post('/commands/:id/ack', authenticateDevice('gate:commands'), validate({ params: schema.idParams, body: schema.ack }), controller.ack);

// ---- people ----
router.post('/barrier/open', ...user, authorize(GUARD, FACILITY_MANAGER), validate({ body: schema.requestOpen }), controller.requestOpen);
router.get('/barrier/commands', ...user, authorize(GUARD, FACILITY_MANAGER), validate({ query: schema.listCommands }), controller.listCommands);
router.get('/gates', ...user, authorize(GUARD, FACILITY_MANAGER), controller.gates);

export default router;
