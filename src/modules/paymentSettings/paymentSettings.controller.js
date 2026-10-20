import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx } from '../../common/utils/context.js';
import * as service from './paymentSettings.service.js';

// society side
export const view = asyncHandler(async (req, res) => ok(res, await service.view(ctx(req))));
export const status = asyncHandler(async (req, res) => ok(res, await service.onlineStatus(req.user.society)));
export const chooseMode = asyncHandler(async (req, res) => ok(res, await service.chooseMode(ctx(req), req.body.mode)));
export const saveOwnKeys = asyncHandler(async (req, res) => ok(res, await service.saveOwnKeys(ctx(req), req.body)));
export const testConnection = asyncHandler(async (req, res) => ok(res, await service.testConnection(ctx(req))));
export const startTestPayment = asyncHandler(async (req, res) => ok(res, await service.startTestPayment(ctx(req))));
export const verifyTestPayment = asyncHandler(async (req, res) => ok(res, await service.verifyTestPayment(ctx(req), req.body)));
export const enable = asyncHandler(async (req, res) => ok(res, await service.enable(ctx(req))));
export const disable = asyncHandler(async (req, res) => ok(res, await service.disable(ctx(req))));

// platform side
export const platformView = asyncHandler(async (req, res) => ok(res, await service.platformView(req.params.societyId)));
export const platformUpdate = asyncHandler(async (req, res) => ok(res, await service.platformUpdate(req.user, req.params.societyId, req.body)));
export const refreshRoute = asyncHandler(async (req, res) => ok(res, await service.refreshRoute(req.user, req.params.societyId)));
