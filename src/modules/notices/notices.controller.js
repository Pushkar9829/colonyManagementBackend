import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import * as service from './notices.service.js';

export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, q);
  ok(res, items, meta);
});
export const markRead = asyncHandler(async (req, res) => {
  await service.markRead(ctx(req), req.params.id);
  ok(res, { read: true });
});
export const acknowledge = asyncHandler(async (req, res) => ok(res, await service.acknowledge(ctx(req), req.params.id)));
export const ackStatus = asyncHandler(async (req, res) => ok(res, await service.ackStatus(ctx(req), req.params.id)));
export const remindPending = asyncHandler(async (req, res) => ok(res, await service.remindPending(ctx(req), req.params.id)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const remove = asyncHandler(async (req, res) => {
  await service.remove(ctx(req), req.params.id);
  noContent(res);
});
