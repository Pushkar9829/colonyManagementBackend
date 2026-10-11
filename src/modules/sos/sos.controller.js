import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './sos.service.js';

export const raise = asyncHandler(async (req, res) => created(res, await service.raise(ctx(req), req.body)));
export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const acknowledge = asyncHandler(async (req, res) => ok(res, await service.acknowledge(ctx(req), req.params.id)));
export const resolve = asyncHandler(async (req, res) => ok(res, await service.resolve(ctx(req), req.params.id, req.body?.resolutionNote)));
