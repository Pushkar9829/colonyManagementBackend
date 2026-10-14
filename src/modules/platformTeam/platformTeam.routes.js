import { Router } from 'express';
import { requirePlatform } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './platformTeam.controller.js';
import * as schema from './platformTeam.validation.js';

// Mounted inside /api/v1/platform (already behind authenticate + any platform member).
// Team and role changes are written to the activity log by the service itself.
export const platformRouter = Router();
const manage = requirePlatform('team.manage');

// Every member may read the catalogue: the console uses it to label permissions.
platformRouter.get('/permissions', controller.catalogue);

platformRouter.get('/roles', manage, controller.listRoles);
platformRouter.post('/roles', manage, validate({ body: schema.createRole }), controller.createRole);
platformRouter.patch('/roles/:id', manage, validate({ params: schema.idParams, body: schema.updateRole }), controller.updateRole);
platformRouter.delete('/roles/:id', manage, validate({ params: schema.idParams }), controller.deleteRole);

platformRouter.get('/team', manage, validate({ query: schema.listMembers }), controller.listMembers);
platformRouter.post('/team', manage, validate({ body: schema.invite }), controller.invite);
platformRouter.patch('/team/:id', manage, validate({ params: schema.idParams, body: schema.changeRole }), controller.changeRole);
platformRouter.post('/team/:id/deactivate', manage, validate({ params: schema.idParams }), controller.deactivate);
platformRouter.post('/team/:id/reactivate', manage, validate({ params: schema.idParams }), controller.reactivate);
platformRouter.delete('/team/:id', manage, validate({ params: schema.idParams }), controller.remove);

platformRouter.get('/activity', requirePlatform('audit.view'), validate({ query: schema.activity }), controller.activity);
platformRouter.get('/activity/actors', requirePlatform('audit.view'), controller.actors);
