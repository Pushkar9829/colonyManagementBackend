import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx } from '../../common/utils/context.js';
import { WORK_CATEGORIES } from './occupation.js';
import * as service from './people.service.js';

export const options = (_req, res) => ok(res, { workCategories: WORK_CATEGORIES });
export const getMine = asyncHandler(async (req, res) => ok(res, await service.getMine(ctx(req))));
export const updateMine = asyncHandler(async (req, res) => ok(res, await service.updateMine(ctx(req), req.body)));
export const forUnit = asyncHandler(async (req, res) => ok(res, await service.forUnit(ctx(req), req.params.unitId)));
export const updateForUser = asyncHandler(async (req, res) => ok(res, await service.updateForUser(ctx(req), req.params.userId, req.body)));
export const updateForFamilyMember = asyncHandler(async (req, res) =>
  ok(res, await service.updateForFamilyMember(ctx(req), req.params.unitId, req.params.memberId, req.body)));
