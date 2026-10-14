import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './dailyHelp.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const removeFromMyUnit = asyncHandler(async (req, res) => {
  await service.removeFromMyUnit(ctx(req), req.params.id);
  noContent(res);
});
export const attendance = asyncHandler(async (req, res) => {
  const { items, meta } = await service.attendance(ctx(req), req.params.id, getPagination(query(req)));
  ok(res, items, meta);
});
export const gateScan = asyncHandler(async (req, res) => ok(res, await service.gateScan(ctx(req), req.body.passcode, { gateId: req.body.gateId })));

export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const listReviews = asyncHandler(async (req, res) => {
  const { items, meta } = await service.listReviews(ctx(req), req.params.id, getPagination(query(req)));
  ok(res, items, meta);
});
export const review = asyncHandler(async (req, res) => ok(res, await service.review(ctx(req), req.params.id, req.body)));
export const removeReview = asyncHandler(async (req, res) => {
  await service.removeReview(ctx(req), req.params.id);
  noContent(res);
});
export const setEmployment = asyncHandler(async (req, res) => ok(res, await service.setEmployment(ctx(req), req.params.id, req.body)));
export const markSalaryPaid = asyncHandler(async (req, res) => ok(res, await service.markSalaryPaid(ctx(req), req.params.id, req.body)));
export const listLeaves = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listLeaves(ctx(req), req.params.id, q, getPagination(q));
  ok(res, items, meta);
});
export const addLeave = asyncHandler(async (req, res) => created(res, await service.addLeave(ctx(req), req.params.id, req.body)));
export const removeLeave = asyncHandler(async (req, res) => {
  await service.removeLeave(ctx(req), req.params.id, req.params.leaveId);
  noContent(res);
});
export const addDocuments = asyncHandler(async (req, res) => ok(res, await service.addDocuments(ctx(req), req.params.id, req.body)));
export const setVerification = asyncHandler(async (req, res) => ok(res, await service.setVerification(ctx(req), req.params.id, req.body)));
