import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './subscriptions.service.js';

const sendPdf = (res, { filename, buffer }) => {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.send(buffer);
};
const listed = (res, { items, meta }) => ok(res, items, meta);
// Blank strings from forms clear the field.
const clean = (body) => Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v === '' ? null : v]));

// society side
export const getMine = asyncHandler(async (req, res) => ok(res, await service.getMine(ctx(req))));
export const updateMine = asyncHandler(async (req, res) => ok(res, await service.updateMine(ctx(req), clean(req.body))));
export const listMine = asyncHandler(async (req, res) => {
  const q = query(req);
  listed(res, await service.listMine(ctx(req), q, getPagination(q)));
});
export const getMineById = asyncHandler(async (req, res) => ok(res, await service.getMineById(ctx(req), req.params.id)));
export const pdfMine = asyncHandler(async (req, res) => sendPdf(res, await service.pdfMine(ctx(req), req.params.id)));
export const createOrder = asyncHandler(async (req, res) => ok(res, await service.createOrder(ctx(req), req.params.id)));
export const verify = asyncHandler(async (req, res) => ok(res, await service.verify(ctx(req), req.body)));
export const mockSign = asyncHandler(async (req, res) => ok(res, service.mockSign(req.body.orderId)));

// pay link
export const getByToken = asyncHandler(async (req, res) => ok(res, await service.getByToken(req.params.token)));
export const createOrderByToken = asyncHandler(async (req, res) => ok(res, await service.createOrderByToken(req.params.token, null)));
export const verifyByToken = asyncHandler(async (req, res) => ok(res, await service.verifyByToken(req.params.token, req.body, null)));
export const mockSignByToken = asyncHandler(async (req, res) => ok(res, await service.mockSignByToken(req.params.token, req.body.orderId)));

// platform side
export const listPrices = asyncHandler(async (_req, res) => ok(res, await service.listPrices()));
export const updatePrice = asyncHandler(async (req, res) => ok(res, await service.updatePrice(req.user, req.params.plan, req.body)));
export const listAll = asyncHandler(async (req, res) => {
  const q = query(req);
  listed(res, await service.listAll(q, getPagination(q)));
});
export const summary = asyncHandler(async (_req, res) => ok(res, await service.platformSummary()));
export const getAnyById = asyncHandler(async (req, res) => ok(res, await service.getAnyById(req.params.id)));
export const pdfAny = asyncHandler(async (req, res) => sendPdf(res, await service.pdfAny(req.params.id)));
export const markPaid = asyncHandler(async (req, res) => ok(res, await service.markPaid(req.user, req.params.id, req.body)));
export const voidInvoice = asyncHandler(async (req, res) => ok(res, await service.voidInvoice(req.user, req.params.id, req.body.reason)));
export const runBilling = asyncHandler(async (_req, res) => {
  const generated = await service.generateDueInvoices();
  const dunning = await service.runDunning();
  ok(res, { ...generated, ...dunning });
});
export const getForSociety = asyncHandler(async (req, res) => ok(res, await service.getForSociety(req.params.societyId)));
export const updateForSociety = asyncHandler(async (req, res) => ok(res, await service.updateForSociety(req.user, req.params.societyId, clean(req.body))));
