import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './parcels.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const collect = asyncHandler(async (req, res) => ok(res, await service.collect(ctx(req), req.params.id, req.body)));
export const markReturned = asyncHandler(async (req, res) => ok(res, await service.markReturned(ctx(req), req.params.id, req.body)));
export const remind = asyncHandler(async (req, res) => ok(res, await service.remind(ctx(req), req.params.id)));
export const stats = asyncHandler(async (req, res) => ok(res, await service.stats(ctx(req))));

export const listPreferences = asyncHandler(async (req, res) => ok(res, await service.listPreferences(ctx(req))));
export const createPreference = asyncHandler(async (req, res) => created(res, await service.createPreference(ctx(req), req.body)));
export const removePreference = asyncHandler(async (req, res) => {
  await service.removePreference(ctx(req), req.params.id);
  noContent(res);
});
export const checkPreference = asyncHandler(async (req, res) => ok(res, await service.checkPreference(ctx(req), query(req))));
