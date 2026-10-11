import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './complaints.service.js';
import * as helpdesk from './helpdesk.service.js';

export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const stats = asyncHandler(async (req, res) => ok(res, await service.stats(ctx(req))));
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const assign = asyncHandler(async (req, res) => ok(res, await service.assign(ctx(req), req.params.id, req.body.assignedTo)));
export const changeStatus = asyncHandler(async (req, res) => ok(res, await service.changeStatus(ctx(req), req.params.id, req.body)));
export const addComment = asyncHandler(async (req, res) => ok(res, await service.addComment(ctx(req), req.params.id, req.body)));
export const reopen = asyncHandler(async (req, res) => ok(res, await service.reopen(ctx(req), req.params.id, req.body.note)));
export const rate = asyncHandler(async (req, res) => ok(res, await service.rate(ctx(req), req.params.id, req.body)));

// ---------- helpdesk settings & reports ----------
export const listCategories = asyncHandler(async (req, res) => ok(res, await helpdesk.listCategories(ctx(req), { includeInactive: Boolean(query(req).includeInactive) })));
export const createCategory = asyncHandler(async (req, res) => created(res, await helpdesk.createCategory(ctx(req), req.body)));
export const updateCategory = asyncHandler(async (req, res) => ok(res, await helpdesk.updateCategory(ctx(req), req.params.key, req.body)));
export const suggestCategory = asyncHandler(async (req, res) => ok(res, await helpdesk.suggest(ctx(req), query(req).title)));
export const listRules = asyncHandler(async (req, res) => ok(res, { rules: await helpdesk.listRules(ctx(req)), defaults: helpdesk.DEFAULT_MATRIX }));
export const createRule = asyncHandler(async (req, res) => created(res, await helpdesk.createRule(ctx(req), req.body)));
export const updateRule = asyncHandler(async (req, res) => ok(res, await helpdesk.updateRule(ctx(req), req.params.id, req.body)));
export const deleteRule = asyncHandler(async (req, res) => {
  await helpdesk.deleteRule(ctx(req), req.params.id);
  noContent(res);
});
export const staffPerformance = asyncHandler(async (req, res) => ok(res, await helpdesk.staffPerformance(ctx(req), query(req))));
