import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx } from '../../common/utils/context.js';
import * as service from './dashboard.service.js';

export const get = asyncHandler(async (req, res) => ok(res, await service.forRole(ctx(req))));
