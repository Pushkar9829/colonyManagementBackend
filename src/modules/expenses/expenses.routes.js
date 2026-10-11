import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './expenses.controller.js';
import * as schema from './expenses.validation.js';

// Finance (accountant; admin always passes) manages vendors, bills and payments.
// Facility managers raise purchase requests and look up vendors. Only admins approve requests.
const { ACCOUNTANT, FACILITY_MANAGER } = ROLES;
const finance = authorize(ACCOUNTANT);
const financeOrFm = authorize(ACCOUNTANT, FACILITY_MANAGER);
const adminOnly = authorize();

const router = Router();
router.use(authenticate, requireSociety);

router.get('/settings', financeOrFm, controller.getSettings);
router.patch('/settings', adminOnly, validate({ body: schema.settings }), controller.updateSettings);

// vendors
router.get('/vendors', financeOrFm, validate({ query: schema.listVendors }), controller.listVendors);
router.post('/vendors', finance, validate({ body: schema.createVendor }), controller.createVendor);
router.get('/vendors/:id', financeOrFm, validate({ params: schema.idParams }), controller.getVendor);
router.patch('/vendors/:id', finance, validate({ params: schema.idParams, body: schema.updateVendor }), controller.updateVendor);
router.get('/vendors/:id/statement', finance, validate({ params: schema.idParams, query: schema.statementQuery }), controller.vendorStatement);

// purchase requests (maker-checker)
router.get('/purchase-requests', financeOrFm, validate({ query: schema.listPurchaseRequests }), controller.listPurchaseRequests);
router.post('/purchase-requests', financeOrFm, validate({ body: schema.createPurchaseRequest }), controller.createPurchaseRequest);
router.get('/purchase-requests/:id', financeOrFm, validate({ params: schema.idParams }), controller.getPurchaseRequest);
router.patch('/purchase-requests/:id', financeOrFm, validate({ params: schema.idParams, body: schema.updatePurchaseRequest }), controller.updatePurchaseRequest);
router.delete('/purchase-requests/:id', financeOrFm, validate({ params: schema.idParams }), controller.deletePurchaseRequest);
router.post('/purchase-requests/:id/submit', financeOrFm, validate({ params: schema.idParams }), controller.submitPurchaseRequest);
router.post('/purchase-requests/:id/approve', adminOnly, validate({ params: schema.idParams, body: schema.decision }), controller.approvePurchaseRequest);
router.post('/purchase-requests/:id/reject', adminOnly, validate({ params: schema.idParams, body: schema.rejection }), controller.rejectPurchaseRequest);

// vendor bills
router.get('/bills', finance, validate({ query: schema.listBills }), controller.listBills);
router.post('/bills', finance, validate({ body: schema.createBill }), controller.createBill);
router.get('/bills/:id', finance, validate({ params: schema.idParams }), controller.getBill);
router.post('/bills/:id/cancel', finance, validate({ params: schema.idParams, body: schema.cancel }), controller.cancelBill);

// vendor payments
router.get('/payments', finance, validate({ query: schema.listPayments }), controller.listPayments);
router.post('/payments', finance, validate({ body: schema.createPayment }), controller.createPayment);
router.get('/payments/:id', finance, validate({ params: schema.idParams }), controller.getPayment);
router.post('/payments/:id/cancel', finance, validate({ params: schema.idParams, body: schema.cancel }), controller.cancelPayment);

// recurring expenses
router.get('/recurring', finance, validate({ query: schema.listRecurring }), controller.listRecurring);
router.post('/recurring', finance, validate({ body: schema.createRecurring }), controller.createRecurring);
router.patch('/recurring/:id', finance, validate({ params: schema.idParams, body: schema.updateRecurring }), controller.updateRecurring);
router.post('/recurring/:id/run', finance, validate({ params: schema.idParams }), controller.runRecurring);

// reports
router.get('/reports/ageing', finance, validate({ query: schema.ageingQuery }), controller.ageing);
router.get('/reports/expenses', finance, validate({ query: schema.expenseQuery }), controller.expenseReport);

export default router;
