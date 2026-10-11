import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import { receiveSheet } from './sheets.js';
import * as controller from './billing.controller.js';
import * as schema from './billing.validation.js';

const { ACCOUNTANT, RESIDENT } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

router.get('/summary', authorize(ACCOUNTANT, RESIDENT), validate({ query: z.object({ period: z.string().optional() }) }), controller.summary);
router.get('/defaulters', authorize(ACCOUNTANT), controller.defaulters);
router.post('/generate', authorize(ACCOUNTANT), validate({ body: schema.generate }), controller.generate);
router.post('/apply-late-fees', authorize(ACCOUNTANT), controller.applyLateFees);

// Ledger: residents get their own unit, accountants any unit.
router.get('/statement', authorize(ACCOUNTANT, RESIDENT), validate({ query: schema.statementQuery }), controller.statement);
router.get('/statement.pdf', authorize(ACCOUNTANT, RESIDENT), validate({ query: schema.statementQuery }), controller.statementPdf);
router.get('/statement.xlsx', authorize(ACCOUNTANT, RESIDENT), validate({ query: schema.statementQuery }), controller.statementXlsx);
router.get('/adjustments', authorize(ACCOUNTANT, RESIDENT), validate({ query: schema.listAdjustments }), controller.listAdjustments);

// Waivers: the accountant requests (maker), an admin decides (checker; admin-only routes).
router.get('/waivers', authorize(ACCOUNTANT), validate({ query: schema.listAdjustments }), controller.listWaivers);
router.post('/waivers', authorize(ACCOUNTANT), validate({ body: schema.requestWaiver }), controller.requestWaiver);
router.post('/waivers/:id/approve', authorize(), validate({ params: schema.idParams, body: schema.decideWaiver }), controller.approveWaiver);
router.post('/waivers/:id/reject', authorize(), validate({ params: schema.idParams, body: schema.decideWaiver }), controller.rejectWaiver);

// Advance credit
router.get('/credits', authorize(ACCOUNTANT), controller.creditHolders);
router.post('/credits', authorize(ACCOUNTANT), validate({ body: schema.issueCredit }), controller.issueCredit);
router.post('/credits/apply', authorize(ACCOUNTANT), validate({ body: schema.applyCredit }), controller.applyCredit);
router.post('/refunds', authorize(ACCOUNTANT), validate({ body: schema.refund }), controller.refund);

// Opening balances at go-live
router.get('/opening-balances/template.xlsx', authorize(ACCOUNTANT), controller.openingTemplate);
router.post('/opening-balances', authorize(ACCOUNTANT), validate({ body: schema.openingBalances }), controller.openingBalances);
router.post('/opening-balances/import', authorize(ACCOUNTANT), receiveSheet, controller.importOpeningBalances);

router.get('/', authorize(ACCOUNTANT, RESIDENT), validate({ query: schema.listBills }), controller.list);
router.get('/:id', authorize(ACCOUNTANT, RESIDENT), validate({ params: schema.idParams }), controller.getById);
router.get('/:id/pdf', authorize(ACCOUNTANT, RESIDENT), validate({ params: schema.idParams }), controller.pdf);
router.post('/:id/email', authorize(ACCOUNTANT, RESIDENT), validate({ params: schema.idParams }), controller.email);
router.post('/:id/cancel', authorize(ACCOUNTANT), validate({ params: schema.idParams }), controller.cancel);

export default router;
