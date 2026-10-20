import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './ads.service.js';

const paged = (res, { items, meta }) => ok(res, items, meta);

// Delivery (every signed-in person)
export const active = asyncHandler(async (req, res) => ok(res, await service.active(ctx(req))));
export const event = (type) => asyncHandler(async (req, res) => ok(res, await service.event(ctx(req), req.params.id, type, req.body?.placement)));

// Management; `scope` is fixed by the router ('society' or 'platform').
export const list = (scope) => asyncHandler(async (req, res) => paged(res, await service.list(ctx(req), scope, query(req), getPagination(query(req)))));
export const create = (scope) => asyncHandler(async (req, res) => created(res, await service.create(ctx(req), scope, req.body)));
export const update = (scope) => asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), scope, req.params.id, req.body)));
export const remove = (scope) => asyncHandler(async (req, res) => ok(res, await service.remove(ctx(req), scope, req.params.id)));
export const stats = (scope) => asyncHandler(async (req, res) => ok(res, await service.stats(ctx(req), scope, req.params.id, query(req))));
export const media = (scope) => asyncHandler(async (req, res) => created(res, await service.saveMedia(ctx(req), scope, req.file)));

export const societySettings = asyncHandler(async (req, res) => ok(res, await service.societySettings(ctx(req))));
export const platformSocieties = asyncHandler(async (req, res) => paged(res, await service.platformSocieties(query(req), getPagination(query(req)))));
export const setSocietySetting = asyncHandler(async (req, res) => ok(res, await service.setSocietySetting(ctx(req), req.params.id, req.body.allowSocietyAds)));
