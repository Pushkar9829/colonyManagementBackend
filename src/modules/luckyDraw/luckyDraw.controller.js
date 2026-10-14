import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './luckyDraw.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const publish = asyncHandler(async (req, res) => ok(res, await service.publish(ctx(req), req.params.id)));
export const close = asyncHandler(async (req, res) => ok(res, await service.close(ctx(req), req.params.id)));
export const runDraw = asyncHandler(async (req, res) => ok(res, await service.runDraw(ctx(req), req.params.id)));
export const cancel = asyncHandler(async (req, res) => ok(res, await service.cancel(ctx(req), req.params.id, req.body)));
export const verify = asyncHandler(async (req, res) => ok(res, await service.verify(ctx(req), req.params.id)));
export const listEntries = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listEntries(ctx(req), req.params.id, q, getPagination({ limit: 50, ...q }));
  ok(res, items, meta);
});
export const enter = asyncHandler(async (req, res) => ok(res, await service.enter(ctx(req), req.params.id)));
export const withdraw = asyncHandler(async (req, res) => ok(res, await service.withdraw(ctx(req), req.params.id)));
export const promoteReserve = asyncHandler(async (req, res) => ok(res, await service.promoteReserve(ctx(req), req.params.id, req.params.winnerId, req.body)));
export const markHandedOver = asyncHandler(async (req, res) => ok(res, await service.markHandedOver(ctx(req), req.params.id, req.params.winnerId, req.body)));

// platform console
export const listAll = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listAll(q, getPagination(q));
  ok(res, items, meta);
});
export const platformCancel = asyncHandler(async (req, res) => ok(res, await service.platformCancel(req.user, req.params.id, req.body, req.ip)));
