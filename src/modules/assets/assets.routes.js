import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { pageQuery } from '../../common/utils/schemas.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './assets.controller.js';
import * as schema from './assets.validation.js';

const { FACILITY_MANAGER: FM, STAFF } = ROLES;
const id = { params: schema.idParams };

// Asset register. Managers maintain it; technicians can look assets up (QR scan) and log service notes.
export const assetRouter = Router();
assetRouter.use(authenticate, requireSociety);
assetRouter.get('/stats', authorize(FM), controller.stats);
assetRouter.get('/', authorize(FM, STAFF), validate({ query: schema.listAssets }), controller.list);
assetRouter.post('/', authorize(FM), validate({ body: schema.createAsset }), controller.create);
assetRouter.get('/by-code/:code', authorize(FM, STAFF), validate({ params: schema.codeParams }), controller.getByCode);
assetRouter.get('/:id', authorize(FM, STAFF), validate(id), controller.getById);
assetRouter.patch('/:id', authorize(FM), validate({ ...id, body: schema.updateAsset }), controller.update);
assetRouter.post('/:id/status', authorize(FM), validate({ ...id, body: schema.changeStatus }), controller.changeStatus);
assetRouter.post('/:id/files', authorize(FM), validate({ ...id, body: schema.addFiles }), controller.addFiles);
assetRouter.post('/:id/files/remove', authorize(FM), validate({ ...id, body: schema.removeFile }), controller.removeFile);
assetRouter.put('/:id/amc', authorize(FM), validate({ ...id, body: schema.setAmc }), controller.setAmc);
assetRouter.get('/:id/amc-visits', authorize(FM), validate(id), controller.listAmcVisits);
assetRouter.post('/:id/amc-visits', authorize(FM), validate({ ...id, body: schema.amcVisit }), controller.addAmcVisit);
assetRouter.get('/:id/timeline', authorize(FM, STAFF), validate({ ...id, query: pageQuery }), controller.timeline);
assetRouter.post('/:id/events', authorize(FM, STAFF), validate({ ...id, body: schema.serviceEvent }), controller.addEvent);

// Fire safety compliance register.
export const fireRouter = Router();
fireRouter.use(authenticate, requireSociety);
fireRouter.get('/summary', authorize(FM, STAFF), controller.fireSummary);
fireRouter.get('/extinguishers', authorize(FM, STAFF), validate({ query: schema.listExtinguishers }), controller.listExtinguishers);
fireRouter.post('/extinguishers', authorize(FM), validate({ body: schema.createExtinguisher }), controller.createExtinguisher);
fireRouter.patch('/extinguishers/:id', authorize(FM), validate({ ...id, body: schema.updateExtinguisher }), controller.updateExtinguisher);
fireRouter.post('/extinguishers/:id/refill', authorize(FM, STAFF), validate({ ...id, body: schema.refillExtinguisher }), controller.refillExtinguisher);
fireRouter.get('/drills', authorize(FM, STAFF), validate({ query: pageQuery }), controller.listDrills);
fireRouter.post('/drills', authorize(FM), validate({ body: schema.createDrill }), controller.createDrill);
fireRouter.get('/nocs', authorize(FM), controller.listNocs);
fireRouter.post('/nocs', authorize(FM), validate({ body: schema.createNoc }), controller.createNoc);
