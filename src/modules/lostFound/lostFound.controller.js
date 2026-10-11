import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './lostFound.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const remove = asyncHandler(async (req, res) => {
  await service.remove(ctx(req), req.params.id);
  noContent(res);
});
export const claim = asyncHandler(async (req, res) => created(res, await service.claim(ctx(req), req.params.id, req.body)));
export const withdrawClaim = asyncHandler(async (req, res) => ok(res, await service.withdrawClaim(ctx(req), req.params.id)));
export const acceptClaim = asyncHandler(async (req, res) => ok(res, await service.decideClaim(ctx(req), req.params.id, req.params.claimId, true)));
export const rejectClaim = asyncHandler(async (req, res) => ok(res, await service.decideClaim(ctx(req), req.params.id, req.params.claimId, false)));
export const close = asyncHandler(async (req, res) => ok(res, await service.close(ctx(req), req.params.id, req.body)));
