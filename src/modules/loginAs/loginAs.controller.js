import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './loginAs.service.js';

const bearerToken = (req) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  return scheme === 'Bearer' ? token : null;
};
const paged = (res, { items, meta }) => ok(res, items, meta);

export const start = asyncHandler(async (req, res) => created(res, await service.start(ctx(req), req.body)));
export const exit = asyncHandler(async (req, res) => ok(res, await service.exit(bearerToken(req), req.ip)));
export const current = asyncHandler(async (req, res) => ok(res, req.user.actingAs || null));
export const myActivity = asyncHandler(async (req, res) => ok(res, await service.myActivity(ctx(req))));
export const myRules = asyncHandler(async (req, res) => ok(res, await service.myRules(ctx(req))));
export const societySessions = asyncHandler(async (req, res) => paged(res, await service.societySessions(ctx(req), getPagination(query(req)))));

export const getGlobalPolicy = asyncHandler(async (_req, res) => ok(res, await service.getGlobalPolicy()));
export const setGlobalPolicy = asyncHandler(async (req, res) => ok(res, await service.setGlobalPolicy(ctx(req), req.body)));
export const getSocietyPolicy = asyncHandler(async (req, res) => ok(res, await service.getSocietyPolicy(req.params.id)));
export const setSocietyPolicy = asyncHandler(async (req, res) => ok(res, await service.setSocietyPolicy(ctx(req), req.params.id, req.body)));
export const platformSessions = asyncHandler(async (req, res) => paged(res, await service.platformSessions(query(req), getPagination(query(req)))));
export const societyMembers = asyncHandler(async (req, res) => paged(res, await service.societyMembers(req.params.id, query(req), getPagination(query(req)))));
