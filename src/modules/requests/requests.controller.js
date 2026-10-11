import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './requests.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const moves = asyncHandler(async (req, res) => ok(res, await service.moves(ctx(req), query(req))));
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const addComment = asyncHandler(async (req, res) => ok(res, await service.addComment(ctx(req), req.params.id, req.body)));
export const respond = asyncHandler(async (req, res) => ok(res, await service.respond(ctx(req), req.params.id, req.body)));
export const cancel = asyncHandler(async (req, res) => ok(res, await service.cancel(ctx(req), req.params.id)));
export const requestInfo = asyncHandler(async (req, res) => ok(res, await service.requestInfo(ctx(req), req.params.id, req.body)));
export const approve = asyncHandler(async (req, res) => ok(res, await service.approve(ctx(req), req.params.id, req.body)));
export const reject = asyncHandler(async (req, res) => ok(res, await service.reject(ctx(req), req.params.id, req.body)));
export const letterPdf = asyncHandler(async (req, res) => {
  const { buffer, filename } = await service.letterPdf(ctx(req), req.params.id);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'no-store' });
  res.send(buffer);
});
