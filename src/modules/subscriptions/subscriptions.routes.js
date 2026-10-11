import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import env from '../../config/env.js';
import * as controller from './subscriptions.controller.js';
import * as schema from './subscriptions.validation.js';

const { ACCOUNTANT } = ROLES;

// /api/v1/subscription — the society's own subscription with the platform.
const router = Router();

// Pay link: works without a society session, because a suspended society's members cannot open it.
// The 32-character random token is the credential and only allows paying that one invoice.
router.get('/pay/:token', validate({ params: schema.tokenParams }), controller.getByToken);
router.post('/pay/:token/order', validate({ params: schema.tokenParams }), controller.createOrderByToken);
router.post('/pay/:token/verify', validate({ params: schema.tokenParams, body: schema.verify }), controller.verifyByToken);
if (env.PAYMENT_PROVIDER === 'mock') {
  router.post('/pay/:token/mock-sign', validate({ params: schema.tokenParams, body: schema.mockSign }), controller.mockSignByToken);
}

router.use(authenticate, requireSociety);
router.get('/', authorize(ACCOUNTANT), controller.getMine);
router.patch('/', authorize(), validate({ body: schema.updateMine }), controller.updateMine);
router.get('/invoices', authorize(ACCOUNTANT), validate({ query: schema.listInvoices }), controller.listMine);
router.get('/invoices/:id', authorize(ACCOUNTANT), validate({ params: schema.idParams }), controller.getMineById);
router.get('/invoices/:id/pdf', authorize(ACCOUNTANT), validate({ params: schema.idParams }), controller.pdfMine);
router.post('/invoices/:id/order', authorize(ACCOUNTANT), validate({ params: schema.idParams }), controller.createOrder);
router.post('/verify', authorize(ACCOUNTANT), validate({ body: schema.verify }), controller.verify);
if (env.PAYMENT_PROVIDER === 'mock') {
  router.post('/mock/sign', authorize(ACCOUNTANT), validate({ body: schema.mockSign }), controller.mockSign);
}

export default router;

// Mounted inside /api/v1/platform (already behind authenticate + requirePlatformAdmin).
export const platformRouter = Router();
platformRouter.get('/plans', controller.listPrices);
platformRouter.put('/plans/:plan', validate({ params: schema.planParams, body: schema.updatePrice }), controller.updatePrice);
platformRouter.get('/invoices', validate({ query: schema.listInvoices }), controller.listAll);
platformRouter.get('/invoices/summary', controller.summary);
platformRouter.get('/invoices/:id', validate({ params: schema.idParams }), controller.getAnyById);
platformRouter.get('/invoices/:id/pdf', validate({ params: schema.idParams }), controller.pdfAny);
platformRouter.post('/invoices/:id/mark-paid', validate({ params: schema.idParams, body: schema.markPaid }), controller.markPaid);
platformRouter.post('/invoices/:id/void', validate({ params: schema.idParams, body: schema.voidInvoice }), controller.voidInvoice);
platformRouter.post('/billing/run', controller.runBilling);
platformRouter.get('/subscriptions/:societyId', validate({ params: schema.societyParams }), controller.getForSociety);
platformRouter.patch('/subscriptions/:societyId', validate({ params: schema.societyParams, body: schema.updateForSociety }), controller.updateForSociety);
