import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './platformTeam.service.js';

export const catalogue = asyncHandler(async (_req, res) => ok(res, service.catalogue()));

export const listRoles = asyncHandler(async (_req, res) => ok(res, await service.listRoles()));
export const createRole = asyncHandler(async (req, res) => created(res, await service.createRole(ctx(req), req.body)));
export const updateRole = asyncHandler(async (req, res) => ok(res, await service.updateRole(ctx(req), req.params.id, req.body)));
export const deleteRole = asyncHandler(async (req, res) => {
  await service.deleteRole(ctx(req), req.params.id);
  noContent(res);
});

export const listMembers = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listMembers(q, getPagination(q));
  ok(res, items, meta);
});
export const invite = asyncHandler(async (req, res) => created(res, await service.inviteMember(ctx(req), req.body)));
export const changeRole = asyncHandler(async (req, res) => ok(res, await service.changeRole(ctx(req), req.params.id, req.body.roleId)));
export const deactivate = asyncHandler(async (req, res) => ok(res, await service.setActive(ctx(req), req.params.id, false)));
export const reactivate = asyncHandler(async (req, res) => ok(res, await service.setActive(ctx(req), req.params.id, true)));
export const remove = asyncHandler(async (req, res) => {
  await service.removeMember(ctx(req), req.params.id);
  noContent(res);
});

export const activity = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.activity(q, getPagination(q));
  ok(res, items, meta);
});
export const actors = asyncHandler(async (_req, res) => ok(res, await service.actors()));
