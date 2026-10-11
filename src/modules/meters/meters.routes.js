import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { authenticateDevice } from '../../common/middleware/device.js';
import { validate } from '../../common/middleware/validate.js';
import { pageQuery } from '../../common/utils/schemas.js';
import { ROLES } from '../../common/constants/index.js';
import { receiveSheet } from '../billing/sheets.js';
import * as controller from './meters.controller.js';
import * as schema from './meters.validation.js';

const { ACCOUNTANT, FACILITY_MANAGER, RESIDENT } = ROLES;
const READERS = [ACCOUNTANT, FACILITY_MANAGER, RESIDENT];
const OPERATORS = [ACCOUNTANT, FACILITY_MANAGER];
const router = Router();

// Smart meters / data concentrators post with an X-Device-Key that has the meters:write scope.
router.post('/device-readings', authenticateDevice('meters:write'), validate({ body: schema.deviceReadings }), controller.deviceReadings);

router.use(authenticate, requireSociety);

router.get('/tariffs', authorize(...READERS), controller.listTariffs);
router.post('/tariffs', authorize(ACCOUNTANT), validate({ body: schema.createTariff }), controller.createTariff);
router.patch('/tariffs/:id', authorize(ACCOUNTANT), validate({ params: schema.idParams, body: schema.updateTariff }), controller.updateTariff);

router.get('/sheet', authorize(...OPERATORS), validate({ query: schema.sheetQuery }), controller.sheet);
router.get('/sheet.xlsx', authorize(...OPERATORS), validate({ query: schema.sheetQuery }), controller.sheetXlsx);
router.get('/consumption', authorize(...READERS), validate({ query: schema.consumptionQuery }), controller.consumption);
router.post('/readings/bulk', authorize(...OPERATORS), validate({ body: schema.bulkReadings }), controller.bulkReadings);
router.post('/readings/import', authorize(...OPERATORS), receiveSheet, controller.importReadings);
router.delete('/readings/:id', authorize(...OPERATORS), validate({ params: schema.idParams }), controller.deleteReading);

router.get('/', authorize(...READERS), validate({ query: schema.listMeters }), controller.listMeters);
router.post('/', authorize(...OPERATORS), validate({ body: schema.createMeter }), controller.createMeter);
router.get('/:id', authorize(...READERS), validate({ params: schema.idParams }), controller.getMeter);
router.patch('/:id', authorize(...OPERATORS), validate({ params: schema.idParams, body: schema.updateMeter }), controller.updateMeter);
router.post('/:id/replace', authorize(...OPERATORS), validate({ params: schema.idParams, body: schema.replaceMeter }), controller.replaceMeter);
router.get('/:id/readings', authorize(...READERS), validate({ params: schema.idParams, query: pageQuery }), controller.listReadings);
router.post('/:id/readings', authorize(...OPERATORS), validate({ params: schema.idParams, body: schema.addReading }), controller.addReading);

export default router;
