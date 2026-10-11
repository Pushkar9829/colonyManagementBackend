import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './platform.service.js';

export const stats = asyncHandler(async (_req, res) => ok(res, await service.stats()));
export const listSocieties = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listSocieties(q, getPagination(q));
  ok(res, items, meta);
});
export const getSociety = asyncHandler(async (req, res) => ok(res, await service.getSociety(req.params.id)));
export const updateSociety = asyncHandler(async (req, res) => ok(res, await service.updateSociety(req.user, req.params.id, req.body)));
export const jobs = asyncHandler(async (_req, res) => ok(res, await service.jobs()));
