import { Router } from 'express';
import { authenticate, authorize, requirePlatformAdmin } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './privacy.controller.js';
import * as schema from './privacy.validation.js';

// The signed-in person's own data rights (any role, with or without a society open).
export const meRouter = Router();
meRouter.use(authenticate);
meRouter.get('/data-export', controller.exportMyData);
meRouter.get('/deletion-request', controller.myRequest);
meRouter.post('/deletion-request', validate({ body: schema.deletionRequest }), controller.requestDeletion);
meRouter.delete('/deletion-request', controller.cancelRequest);

// Deciding on requests: the society admin for their members; the platform owner for people with no society.
const adminOrPlatform = (req, res, next) => (req.user.society ? authorize()(req, res, next) : requirePlatformAdmin(req, res, next));

export const privacyRouter = Router();
privacyRouter.use(authenticate, adminOrPlatform);
privacyRouter.get('/deletion-requests', validate({ query: schema.listRequests }), controller.list);
privacyRouter.post('/deletion-requests/:id/approve', validate({ params: schema.idParams, body: schema.approve }), controller.approve);
privacyRouter.post('/deletion-requests/:id/reject', validate({ params: schema.idParams, body: schema.reject }), controller.reject);
