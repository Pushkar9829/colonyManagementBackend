import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import * as service from './insights.service.js';

export const suggestCategory = asyncHandler(async (req, res) => ok(res, await service.suggestCategory(ctx(req), req.body)));
export const defaulterRisk = asyncHandler(async (req, res) => ok(res, await service.defaulterRisk(ctx(req), query(req))));
export const unitRisk = asyncHandler(async (req, res) => ok(res, await service.unitRisk(ctx(req), req.params.unitId)));
export const listTemplates = asyncHandler(async (_req, res) => ok(res, service.listTemplates()));
export const renderTemplate = asyncHandler(async (req, res) => ok(res, await service.renderTemplate(ctx(req), req.params.key, req.body.values)));
export const health = asyncHandler(async (req, res) => ok(res, await service.health(ctx(req), query(req).period)));
