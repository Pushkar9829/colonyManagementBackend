import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import { sendXlsx } from '../assets/facility.shared.js';
import * as service from './utilityLogs.service.js';

export const listPoints = asyncHandler(async (req, res) => ok(res, await service.listPoints(ctx(req), query(req))));
export const createPoint = asyncHandler(async (req, res) => created(res, await service.createPoint(ctx(req), req.body)));
export const updatePoint = asyncHandler(async (req, res) => ok(res, await service.updatePoint(ctx(req), req.params.id, req.body)));
export const createReading = asyncHandler(async (req, res) => created(res, await service.createReading(ctx(req), req.body)));
export const listReadings = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listReadings(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const summary = asyncHandler(async (req, res) => ok(res, await service.summary(ctx(req), query(req))));
export const exportXlsx = asyncHandler(async (req, res) => {
  const q = query(req);
  sendXlsx(res, await service.exportXlsx(ctx(req), q), `utility-${q.kind}-${q.groupBy}.xlsx`);
});
