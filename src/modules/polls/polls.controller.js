import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import * as service from './polls.service.js';

export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(ctx(req), query(req));
  ok(res, items, meta);
});
export const vote = asyncHandler(async (req, res) => ok(res, await service.vote(ctx(req), req.params.id, req.body.optionIndex)));
export const close = asyncHandler(async (req, res) => ok(res, await service.close(ctx(req), req.params.id)));
export const voters = asyncHandler(async (req, res) => ok(res, await service.voters(ctx(req), req.params.id)));
