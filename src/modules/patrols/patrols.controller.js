import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './patrols.service.js';

const paged = (fn) =>
  asyncHandler(async (req, res) => {
    const q = query(req);
    const { items, meta } = await fn(ctx(req), q, getPagination(q));
    ok(res, items, meta);
  });
const gone = (fn) =>
  asyncHandler(async (req, res) => {
    await fn(ctx(req), req.params.id);
    noContent(res);
  });

export const listCheckpoints = asyncHandler(async (req, res) => ok(res, await service.listCheckpoints(ctx(req), query(req))));
export const createCheckpoint = asyncHandler(async (req, res) => created(res, await service.createCheckpoint(ctx(req), req.body)));
export const updateCheckpoint = asyncHandler(async (req, res) => ok(res, await service.updateCheckpoint(ctx(req), req.params.id, req.body)));
export const removeCheckpoint = gone(service.removeCheckpoint);

export const listRoutes = asyncHandler(async (req, res) => ok(res, await service.listRoutes(ctx(req))));
export const createRoute = asyncHandler(async (req, res) => created(res, await service.createRoute(ctx(req), req.body)));
export const updateRoute = asyncHandler(async (req, res) => ok(res, await service.updateRoute(ctx(req), req.params.id, req.body)));
export const removeRoute = gone(service.removeRoute);

export const scan = asyncHandler(async (req, res) => created(res, await service.scan(ctx(req), req.body)));
export const current = asyncHandler(async (req, res) => ok(res, await service.current(ctx(req))));
export const listRounds = paged(service.listRounds);
export const listScans = paged(service.listScans);
export const report = asyncHandler(async (req, res) => ok(res, await service.report(ctx(req), query(req))));
