import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './tenancy.service.js';

export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const addDocuments = asyncHandler(async (req, res) => ok(res, await service.addDocuments(ctx(req), req.params.id, req.body)));
export const end = asyncHandler(async (req, res) => ok(res, await service.end(ctx(req), req.params.id, req.body)));
export const history = asyncHandler(async (req, res) => ok(res, await service.history(ctx(req), req.params.unitId)));
