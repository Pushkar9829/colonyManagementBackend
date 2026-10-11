import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import env from '../../config/env.js';
import * as controller from './payments.controller.js';
import * as schema from './payments.validation.js';

const { ACCOUNTANT, RESIDENT } = ROLES;
const router = Router();
router.use(authenticate, requireSociety);

router.get('/', authorize(ACCOUNTANT, RESIDENT), validate({ query: schema.listPayments }), controller.list);
router.post('/offline', authorize(ACCOUNTANT), validate({ body: schema.recordOffline }), controller.recordOffline);
router.post('/advance', authorize(ACCOUNTANT), validate({ body: schema.recordAdvance }), controller.recordAdvance);
router.post('/orders', authorize(RESIDENT), validate({ body: schema.createOrder }), controller.createOrder);
router.post('/verify', authorize(RESIDENT), validate({ body: schema.verifyOnline }), controller.verifyOnline);
if (env.PAYMENT_PROVIDER === 'mock') {
  router.post('/mock/sign', authorize(RESIDENT), validate({ body: schema.mockSign }), controller.mockSign);
}

// Autopay (UPI AutoPay / e-NACH mandates)
router.get('/autopay', authorize(RESIDENT), controller.myAutopay);
router.post('/autopay', authorize(RESIDENT), validate({ body: schema.optIn }), controller.optIn);
router.delete('/autopay', authorize(RESIDENT), controller.cancelMine);
router.get('/mandates', authorize(ACCOUNTANT), validate({ query: schema.listMandates }), controller.mandates);
router.post('/mandates/:id/cancel', authorize(ACCOUNTANT), validate({ params: schema.idParams }), controller.cancelMandate);

router.get('/:id/receipt', authorize(ACCOUNTANT, RESIDENT), validate({ params: schema.idParams }), controller.receipt);
router.get('/:id/receipt.pdf', authorize(ACCOUNTANT, RESIDENT), validate({ params: schema.idParams }), controller.receiptPdf);
router.post('/:id/email', authorize(ACCOUNTANT, RESIDENT), validate({ params: schema.idParams }), controller.emailReceipt);
router.post('/:id/bounce', authorize(ACCOUNTANT), validate({ params: schema.idParams, body: schema.bounce }), controller.bounce);

export default router;
