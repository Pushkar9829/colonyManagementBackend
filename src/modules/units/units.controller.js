import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './units.service.js';

export const listBlocks = asyncHandler(async (req, res) => ok(res, await service.listBlocks(ctx(req))));
export const createBlock = asyncHandler(async (req, res) => created(res, await service.createBlock(ctx(req), req.body)));
export const updateBlock = asyncHandler(async (req, res) => ok(res, await service.updateBlock(ctx(req), req.params.id, req.body)));
export const deleteBlock = asyncHandler(async (req, res) => {
  await service.deleteBlock(ctx(req), req.params.id);
  noContent(res);
});

export const listUnits = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listUnits(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const getUnit = asyncHandler(async (req, res) => ok(res, await service.getUnit(ctx(req), req.params.id)));
export const createUnit = asyncHandler(async (req, res) => created(res, await service.createUnit(ctx(req), req.body)));
export const bulkCreate = asyncHandler(async (req, res) => created(res, await service.bulkCreate(ctx(req), req.body)));
export const updateUnit = asyncHandler(async (req, res) => ok(res, await service.updateUnit(ctx(req), req.params.id, req.body)));
export const deleteUnit = asyncHandler(async (req, res) => {
  await service.deleteUnit(ctx(req), req.params.id);
  noContent(res);
});
