import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './payments.service.js';
import * as autopay from './autopay.service.js';

export const recordOffline = asyncHandler(async (req, res) => created(res, await service.recordOffline(ctx(req), req.body)));
export const recordAdvance = asyncHandler(async (req, res) => created(res, await service.recordAdvance(ctx(req), req.body)));
export const createOrder = asyncHandler(async (req, res) =>
  created(res, req.body.bill ? await service.createOrder(ctx(req), req.body.bill) : await service.createAdvanceOrder(ctx(req), req.body.advance)),
);
export const verifyOnline = asyncHandler(async (req, res) => ok(res, await service.verifyOnline(ctx(req), req.body)));
export const mockSign = asyncHandler(async (req, res) => ok(res, await service.mockSign(req.body.orderId, req.user.society)));
export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const receipt = asyncHandler(async (req, res) => ok(res, await service.receipt(ctx(req), req.params.id)));
export const receiptPdf = asyncHandler(async (req, res) => {
  const { filename, buffer } = await service.receiptPdfBuffer(ctx(req), req.params.id);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'private, no-store' }).send(buffer);
});
export const emailReceipt = asyncHandler(async (req, res) => ok(res, await service.emailReceipt(ctx(req), req.params.id)));
export const bounce = asyncHandler(async (req, res) => ok(res, await service.bounce(ctx(req), req.params.id, req.body)));

export const myAutopay = asyncHandler(async (req, res) => ok(res, await autopay.mine(ctx(req))));
export const startMandate = asyncHandler(async (req, res) => created(res, await autopay.start(ctx(req), req.body)));
export const confirmMandate = asyncHandler(async (req, res) => ok(res, await autopay.confirm(ctx(req), req.body)));
export const optIn = asyncHandler(async (req, res) => ok(res, await autopay.optIn(ctx(req), req.body)));
export const cancelMine = asyncHandler(async (req, res) => ok(res, await autopay.cancel(ctx(req))));
export const cancelMandate = asyncHandler(async (req, res) => ok(res, await autopay.cancel(ctx(req), req.params.id)));
export const mandates = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await autopay.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
