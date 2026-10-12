import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx } from '../../common/utils/context.js';
import * as service from './society.service.js';
import * as setup from './setup.service.js';

export const getMine = asyncHandler(async (req, res) => ok(res, await service.getById(req.user.society)));
export const updateProfile = asyncHandler(async (req, res) => ok(res, await service.updateProfile(ctx(req), req.body)));
export const updateSettings = asyncHandler(async (req, res) => ok(res, await service.updateSettings(ctx(req), req.body)));
export const regenerateCode = asyncHandler(async (req, res) => ok(res, await service.regenerateCode(ctx(req))));
export const setupStatus = asyncHandler(async (req, res) => ok(res, await setup.setupStatus(ctx(req))));
export const dismissSetup = asyncHandler(async (req, res) => ok(res, await setup.dismissSetup(ctx(req))));
