import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './kyc.service.js';

export const submit = asyncHandler(async (req, res) => created(res, await service.submit(ctx(req), req.body)));
export const mine = asyncHandler(async (req, res) => ok(res, await service.mine(ctx(req))));
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const removeMine = asyncHandler(async (req, res) => {
  await service.removeMine(ctx(req), req.params.id);
  noContent(res);
});
export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const verify = asyncHandler(async (req, res) => ok(res, await service.verify(ctx(req), req.params.id)));
export const reject = asyncHandler(async (req, res) => ok(res, await service.reject(ctx(req), req.params.id, req.body.reason)));
export const completion = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.completion(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
