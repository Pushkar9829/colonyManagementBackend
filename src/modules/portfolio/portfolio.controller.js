import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import * as service from './portfolio.service.js';

export const overview = asyncHandler(async (req, res) => ok(res, await service.overview(req.user._id, req.user.membershipId)));
