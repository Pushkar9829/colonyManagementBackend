import { Router } from 'express';
import { authenticate, authorize, requirePlatform, requirePlatformAny, requireSociety } from '../../common/middleware/auth.js';
import { audited } from '../platformTeam/platformAudit.js';
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

// Mounted inside /api/v1/platform (already behind authenticate + any platform member); each route needs its
// own platform permission and every change goes to the platform activity log.
export const platformRouter = Router();
const invoiceSociety = (_req, data) => data?.invoice?.society || data?.society;
platformRouter.get('/plans', requirePlatform('plans.view'), controller.listPrices);
platformRouter.put('/plans/:plan', requirePlatform('plans.manage'), validate({ params: schema.planParams, body: schema.updatePrice }),
  audited('plan.price_updated', { targetType: 'Plan', details: (req) => ({ plan: req.params.plan, ...req.body }) }), controller.updatePrice);
platformRouter.get('/invoices', requirePlatform('invoices.view'), validate({ query: schema.listInvoices }), controller.listAll);
platformRouter.get('/invoices/summary', requirePlatform('invoices.view'), controller.summary);
platformRouter.get('/invoices/:id', requirePlatform('invoices.view'), validate({ params: schema.idParams }), controller.getAnyById);
platformRouter.get('/invoices/:id/pdf', requirePlatform('invoices.view'), validate({ params: schema.idParams }), controller.pdfAny);
platformRouter.post('/invoices/:id/mark-paid', requirePlatform('invoices.manage'), validate({ params: schema.idParams, body: schema.markPaid }),
  audited('invoice.marked_paid', { targetType: 'PlatformInvoice', society: invoiceSociety, details: (req, data) => ({ number: data?.invoice?.number, ...req.body }) }), controller.markPaid);
platformRouter.post('/invoices/:id/void', requirePlatform('invoices.manage'), validate({ params: schema.idParams, body: schema.voidInvoice }),
  audited('invoice.voided', { targetType: 'PlatformInvoice', society: invoiceSociety, details: (req, data) => ({ number: data?.number, ...req.body }) }), controller.voidInvoice);
platformRouter.post('/billing/run', requirePlatform('billing.run'), audited('billing.run', { details: (_req, data) => data }), controller.runBilling);
platformRouter.get('/subscriptions/:societyId', requirePlatformAny('societies.view', 'invoices.view'), validate({ params: schema.societyParams }), controller.getForSociety);
platformRouter.patch('/subscriptions/:societyId', requirePlatform('invoices.manage'), validate({ params: schema.societyParams, body: schema.updateForSociety }),
  audited('subscription.updated', { targetType: 'Society', targetId: (req) => req.params.societyId, society: (req) => req.params.societyId }), controller.updateForSociety);
