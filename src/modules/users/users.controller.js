import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './users.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const approve = asyncHandler(async (req, res) => ok(res, await service.setApproval(ctx(req), req.params.id, true)));
export const reject = asyncHandler(async (req, res) => ok(res, await service.setApproval(ctx(req), req.params.id, false)));
export const resetPassword = asyncHandler(async (req, res) => {
  await service.resetPassword(ctx(req), req.params.id, req.body.password);
  ok(res, { reset: true });
});
