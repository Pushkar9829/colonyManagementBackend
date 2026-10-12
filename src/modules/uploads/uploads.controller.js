import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent } from '../../common/utils/response.js';
import { ctx } from '../../common/utils/context.js';
import * as service from './uploads.service.js';

export const upload = asyncHandler(async (req, res) => created(res, await service.save(ctx(req), req.file, req.body.folder)));
export const remove = asyncHandler(async (req, res) => {
  await service.remove(ctx(req), req.params.id);
  noContent(res);
});
