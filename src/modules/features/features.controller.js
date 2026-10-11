import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx } from '../../common/utils/context.js';
import * as service from './features.service.js';

export const mine = asyncHandler(async (req, res) => ok(res, await service.forMember(ctx(req))));
export const catalogue = asyncHandler(async (_req, res) => ok(res, service.catalogue()));
export const forSociety = asyncHandler(async (req, res) => ok(res, await service.forSociety(req.params.id)));
export const setOverrides = asyncHandler(async (req, res) => ok(res, await service.setOverrides(req.user, req.params.id, req.body.overrides, req.body.note)));
