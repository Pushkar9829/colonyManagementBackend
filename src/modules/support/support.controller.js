import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './support.service.js';

const listed = (res, { items, meta }) => ok(res, items, meta);

export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  listed(res, await service.list(ctx(req), q, getPagination(q)));
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const reply = asyncHandler(async (req, res) => ok(res, await service.reply(ctx(req), req.params.id, req.body)));
export const close = asyncHandler(async (req, res) => ok(res, await service.close(ctx(req), req.params.id, req.body)));
export const reopen = asyncHandler(async (req, res) => ok(res, await service.reopen(ctx(req), req.params.id, req.body)));

export const listAll = asyncHandler(async (req, res) => {
  const q = query(req);
  listed(res, await service.listAll({ ...q, userId: req.user._id }, getPagination(q)));
});
export const stats = asyncHandler(async (_req, res) => ok(res, await service.stats()));
export const team = asyncHandler(async (_req, res) => ok(res, await service.platformTeam()));
export const getAny = asyncHandler(async (req, res) => ok(res, await service.getAny(req.params.id)));
export const platformReply = asyncHandler(async (req, res) => ok(res, await service.platformReply(req.user, req.params.id, req.body)));
export const setStatus = asyncHandler(async (req, res) => ok(res, await service.setStatus(req.user, req.params.id, req.body)));
export const assign = asyncHandler(async (req, res) => ok(res, await service.assign(req.user, req.params.id, req.body.assignedTo)));
