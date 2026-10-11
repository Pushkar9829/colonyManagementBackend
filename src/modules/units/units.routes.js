import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import { governanceOr } from '../committee/committee.access.js';
import * as controller from './units.controller.js';
import * as schema from './units.validation.js';

const staffReaders = [ROLES.ACCOUNTANT, ROLES.FACILITY_MANAGER, ROLES.GUARD];

export const blockRouter = Router();
blockRouter.use(authenticate, requireSociety);
blockRouter.get('/', controller.listBlocks);
blockRouter.post('/', authorize(), validate({ body: schema.createBlock }), controller.createBlock);
blockRouter.patch('/:id', authorize(), validate({ params: schema.idParams, body: schema.updateBlock }), controller.updateBlock);
blockRouter.delete('/:id', authorize(), validate({ params: schema.idParams }), controller.deleteBlock);

export const unitRouter = Router();
unitRouter.use(authenticate, requireSociety);
// staff readers, plus committee office-bearers (registers, requests)
const unitReaders = governanceOr(ROLES.ADMIN, ...staffReaders);
unitRouter.get('/', unitReaders, validate({ query: schema.listUnits }), controller.listUnits);
unitRouter.post('/', authorize(), validate({ body: schema.createUnit }), controller.createUnit);
unitRouter.post('/bulk', authorize(), validate({ body: schema.bulkCreate }), controller.bulkCreate);
unitRouter.get('/:id', unitReaders, validate({ params: schema.idParams }), controller.getUnit);
unitRouter.patch('/:id', authorize(), validate({ params: schema.idParams, body: schema.updateUnit }), controller.updateUnit);
unitRouter.delete('/:id', authorize(), validate({ params: schema.idParams }), controller.deleteUnit);
