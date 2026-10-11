import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './directory.service.js';

export const getMine = asyncHandler(async (req, res) => ok(res, await service.getMine(ctx(req))));
export const updateMine = asyncHandler(async (req, res) => ok(res, await service.updateMine(ctx(req), req.body)));
export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const contacts = asyncHandler(async (req, res) => ok(res, await service.contacts(ctx(req))));
