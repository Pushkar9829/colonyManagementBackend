import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as vendors from './vendors.service.js';
import * as prs from './purchaseRequests.service.js';
import * as payables from './payables.service.js';
import * as reports from './expenseReports.service.js';
import { render, societyName } from '../accounting/exports.service.js';
import { sendFile } from '../accounting/accounting.controller.js';

const paged = (fn) =>
  asyncHandler(async (req, res) => {
    const q = query(req);
    const { items, meta } = await fn(ctx(req), q, getPagination(q));
    ok(res, items, meta);
  });

// settings
export const getSettings = asyncHandler(async (req, res) => ok(res, await vendors.getSettings(ctx(req))));
export const updateSettings = asyncHandler(async (req, res) => ok(res, await vendors.updateSettings(ctx(req), req.body)));

// vendors
export const listVendors = paged(vendors.list);
export const getVendor = asyncHandler(async (req, res) => ok(res, await vendors.getById(ctx(req), req.params.id)));
export const createVendor = asyncHandler(async (req, res) => created(res, await vendors.create(ctx(req), req.body)));
export const updateVendor = asyncHandler(async (req, res) => ok(res, await vendors.update(ctx(req), req.params.id, req.body)));
export const vendorStatement = asyncHandler(async (req, res) => ok(res, await vendors.statement(ctx(req), req.params.id, query(req))));

// purchase requests
export const listPurchaseRequests = paged(prs.list);
export const getPurchaseRequest = asyncHandler(async (req, res) => ok(res, await prs.getById(ctx(req), req.params.id)));
export const createPurchaseRequest = asyncHandler(async (req, res) => created(res, await prs.create(ctx(req), req.body)));
export const updatePurchaseRequest = asyncHandler(async (req, res) => ok(res, await prs.update(ctx(req), req.params.id, req.body)));
export const deletePurchaseRequest = asyncHandler(async (req, res) => {
  await prs.remove(ctx(req), req.params.id);
  noContent(res);
});
export const submitPurchaseRequest = asyncHandler(async (req, res) => ok(res, await prs.submit(ctx(req), req.params.id)));
export const approvePurchaseRequest = asyncHandler(async (req, res) => ok(res, await prs.approve(ctx(req), req.params.id, req.body)));
export const rejectPurchaseRequest = asyncHandler(async (req, res) => ok(res, await prs.reject(ctx(req), req.params.id, req.body)));

// vendor bills
export const listBills = paged(payables.listBills);
export const getBill = asyncHandler(async (req, res) => ok(res, await payables.getBill(ctx(req), req.params.id)));
export const createBill = asyncHandler(async (req, res) => created(res, await payables.createBill(ctx(req), req.body)));
export const cancelBill = asyncHandler(async (req, res) => ok(res, await payables.cancelBill(ctx(req), req.params.id, req.body)));

// vendor payments
export const listPayments = paged(payables.listPayments);
export const getPayment = asyncHandler(async (req, res) => ok(res, await payables.getPayment(ctx(req), req.params.id)));
export const createPayment = asyncHandler(async (req, res) => created(res, await payables.createPayment(ctx(req), req.body)));
export const cancelPayment = asyncHandler(async (req, res) => ok(res, await payables.cancelPayment(ctx(req), req.params.id, req.body)));

// recurring
export const listRecurring = asyncHandler(async (req, res) => ok(res, await payables.listRecurring(ctx(req), query(req))));
export const createRecurring = asyncHandler(async (req, res) => created(res, await payables.createRecurring(ctx(req), req.body)));
export const updateRecurring = asyncHandler(async (req, res) => ok(res, await payables.updateRecurring(ctx(req), req.params.id, req.body)));
export const runRecurring = asyncHandler(async (req, res) => created(res, await payables.runRecurringNow(ctx(req), req.params.id)));

// reports (JSON, or ?format=xlsx|pdf)
async function respond(req, res, data, table, name) {
  const { format } = query(req);
  if (!format) return ok(res, data);
  const file = await render(table(data, await societyName(req.user.society)), format);
  return sendFile(res, { ...file, filename: `${name}-${data.asOf || data.to}.${file.ext}` });
}
export const ageing = asyncHandler(async (req, res) => respond(req, res, await reports.ageing(ctx(req), query(req)), reports.ageingTable, 'payables-ageing'));
export const expenseReport = asyncHandler(async (req, res) => respond(req, res, await reports.expenseReport(ctx(req), query(req)), reports.expenseTable, 'expenses'));
