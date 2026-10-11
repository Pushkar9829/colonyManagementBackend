import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import { sendXlsx, today } from '../assets/facility.shared.js';
import * as service from './inventory.service.js';

export const listItems = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listItems(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const createItem = asyncHandler(async (req, res) => created(res, await service.createItem(ctx(req), req.body)));
export const getItem = asyncHandler(async (req, res) => ok(res, await service.getItem(ctx(req), req.params.id)));
export const updateItem = asyncHandler(async (req, res) => ok(res, await service.updateItem(ctx(req), req.params.id, req.body)));
export const stockIn = asyncHandler(async (req, res) => created(res, await service.stockIn(ctx(req), req.params.id, req.body)));
export const stockOut = asyncHandler(async (req, res) => created(res, await service.stockOut(ctx(req), req.params.id, req.body)));
export const adjust = asyncHandler(async (req, res) => created(res, await service.adjust(ctx(req), req.params.id, req.body)));
export const listMovements = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listMovements(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const valuation = asyncHandler(async (req, res) => ok(res, await service.valuation(ctx(req))));
export const exportXlsx = asyncHandler(async (req, res) => {
  const q = query(req);
  sendXlsx(res, await service.exportXlsx(ctx(req), q), `inventory-${q.report}-${today()}.xlsx`);
});
