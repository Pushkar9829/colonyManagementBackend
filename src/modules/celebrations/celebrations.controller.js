import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import * as service from './celebrations.service.js';

export const getSettings = asyncHandler(async (req, res) => ok(res, await service.getSettings(ctx(req))));
export const updateSettings = asyncHandler(async (req, res) => ok(res, await service.updateSettings(ctx(req), req.body)));
export const preview = asyncHandler(async (req, res) => ok(res, await service.preview(ctx(req), req.body)));
export const upcoming = asyncHandler(async (req, res) => ok(res, await service.upcoming(ctx(req), query(req))));
export const today = asyncHandler(async (req, res) => ok(res, await service.today(ctx(req))));
