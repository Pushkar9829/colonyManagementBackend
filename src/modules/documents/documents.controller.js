import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './documents.service.js';

export const listFolders = asyncHandler(async (req, res) => ok(res, await service.listFolders(ctx(req))));
export const createFolder = asyncHandler(async (req, res) => created(res, await service.createFolder(ctx(req), req.body)));
export const renameFolder = asyncHandler(async (req, res) => ok(res, await service.renameFolder(ctx(req), req.params.id, req.body)));
export const removeFolder = asyncHandler(async (req, res) => {
  await service.removeFolder(ctx(req), req.params.id);
  noContent(res);
});

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const tags = asyncHandler(async (req, res) => ok(res, await service.tags(ctx(req))));
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const addVersion = asyncHandler(async (req, res) => created(res, await service.addVersion(ctx(req), req.params.id, req.body)));
export const archive = asyncHandler(async (req, res) => ok(res, await service.setArchived(ctx(req), req.params.id, true)));
export const restore = asyncHandler(async (req, res) => ok(res, await service.setArchived(ctx(req), req.params.id, false)));
export const download = asyncHandler(async (req, res) => ok(res, await service.download(ctx(req), req.params.id, query(req).version)));
export const downloads = asyncHandler(async (req, res) => {
  const { items, meta } = await service.downloads(ctx(req), req.params.id, getPagination(query(req)));
  ok(res, items, meta);
});
