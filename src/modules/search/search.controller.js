import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import * as service from './search.service.js';

export const search = asyncHandler(async (req, res) => ok(res, await service.search(ctx(req), query(req).q)));
