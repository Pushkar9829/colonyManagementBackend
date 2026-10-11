import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as c from './inventory.controller.js';
import * as schema from './inventory.validation.js';

const { FACILITY_MANAGER: FM, STAFF } = ROLES;
const id = { params: schema.idParams };

// Stores. Managers run purchases, issues and counts; technicians can check what is in stock.
const router = Router();
router.use(authenticate, requireSociety);

router.get('/items', authorize(FM, STAFF), validate({ query: schema.listItems }), c.listItems);
router.post('/items', authorize(FM), validate({ body: schema.createItem }), c.createItem);
router.get('/items/:id', authorize(FM, STAFF), validate(id), c.getItem);
router.patch('/items/:id', authorize(FM), validate({ ...id, body: schema.updateItem }), c.updateItem);
router.post('/items/:id/in', authorize(FM), validate({ ...id, body: schema.stockIn }), c.stockIn);
router.post('/items/:id/out', authorize(FM), validate({ ...id, body: schema.stockOut }), c.stockOut);
router.post('/items/:id/adjust', authorize(FM), validate({ ...id, body: schema.adjust }), c.adjust);
router.get('/movements', authorize(FM), validate({ query: schema.listMovements }), c.listMovements);
router.get('/valuation', authorize(FM), c.valuation);
router.get('/export', authorize(FM), validate({ query: schema.exportQuery }), c.exportXlsx);

export default router;
