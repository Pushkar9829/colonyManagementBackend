import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx } from '../../common/utils/context.js';
import * as service from './financeSettings.service.js';

export const get = asyncHandler(async (req, res) => ok(res, await service.get(ctx(req))));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.body)));
