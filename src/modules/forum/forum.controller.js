import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './forum.service.js';

export const listCategories = asyncHandler(async (req, res) => ok(res, await service.listCategories(ctx(req), query(req))));
export const createCategory = asyncHandler(async (req, res) => created(res, await service.createCategory(ctx(req), req.body)));
export const updateCategory = asyncHandler(async (req, res) => ok(res, await service.updateCategory(ctx(req), req.params.id, req.body)));

export const listTopics = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listTopics(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const createTopic = asyncHandler(async (req, res) => created(res, await service.createTopic(ctx(req), req.body)));
export const getTopic = asyncHandler(async (req, res) => ok(res, await service.getTopic(ctx(req), req.params.id, getPagination({ limit: 50, ...query(req) }))));
export const updateTopic = asyncHandler(async (req, res) => ok(res, await service.updateTopic(ctx(req), req.params.id, req.body)));
export const deleteTopic = asyncHandler(async (req, res) => {
  await service.deleteTopic(ctx(req), req.params.id, req.body?.reason);
  noContent(res);
});
export const likeTopic = asyncHandler(async (req, res) => ok(res, await service.likeTopic(ctx(req), req.params.id)));
export const setResolved = asyncHandler(async (req, res) => ok(res, await service.setResolved(ctx(req), req.params.id, req.body.resolved)));
export const pin = asyncHandler(async (req, res) => ok(res, await service.setFlag(ctx(req), req.params.id, 'pinned', req.body.value)));
export const lock = asyncHandler(async (req, res) => ok(res, await service.setFlag(ctx(req), req.params.id, 'locked', req.body.value)));

export const addReply = asyncHandler(async (req, res) => created(res, await service.addReply(ctx(req), req.params.id, req.body)));
export const updateReply = asyncHandler(async (req, res) => ok(res, await service.updateReply(ctx(req), req.params.id, req.body)));
export const deleteReply = asyncHandler(async (req, res) => {
  await service.deleteReply(ctx(req), req.params.id, req.body?.reason);
  noContent(res);
});
export const likeReply = asyncHandler(async (req, res) => ok(res, await service.likeReply(ctx(req), req.params.id)));

export const report = asyncHandler(async (req, res) => created(res, await service.report(ctx(req), req.body)));
export const listReports = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listReports(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const resolveReports = asyncHandler(async (req, res) => ok(res, await service.resolveReports(ctx(req), req.body)));
export const mentionable = asyncHandler(async (req, res) => ok(res, await service.mentionable(ctx(req), query(req))));
