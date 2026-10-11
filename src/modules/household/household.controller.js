import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './household.service.js';

export const getMine = asyncHandler(async (req, res) => ok(res, await service.getMine(ctx(req))));
export const updateMine = asyncHandler(async (req, res) => ok(res, await service.updateMine(ctx(req), req.body)));
export const setMyMedical = asyncHandler(async (req, res) => ok(res, await service.setMyMedical(ctx(req), req.body)));

// list = 'members' | 'pets'
export const addItem = (list) => asyncHandler(async (req, res) => created(res, await service.addItem(ctx(req), list, req.body)));
export const updateItem = (list) => asyncHandler(async (req, res) => ok(res, await service.updateItem(ctx(req), list, req.params.itemId, req.body)));
export const removeItem = (list) => asyncHandler(async (req, res) => ok(res, await service.removeItem(ctx(req), list, req.params.itemId)));

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const getForUnit = asyncHandler(async (req, res) => ok(res, await service.getForUnit(ctx(req), req.params.unitId)));
export const sosContext = asyncHandler(async (req, res) => ok(res, await service.sosContext(ctx(req), req.params.sosId)));
