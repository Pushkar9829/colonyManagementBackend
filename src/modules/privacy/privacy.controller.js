import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './privacy.service.js';
import { buildExport } from './export.service.js';

// A file download, not the usual JSON envelope.
export const exportMyData = asyncHandler(async (req, res) => {
  const { filename, data } = await buildExport(ctx(req));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(JSON.stringify(data, null, 2));
});

export const myRequest = asyncHandler(async (req, res) => ok(res, await service.myRequest(ctx(req))));
export const requestDeletion = asyncHandler(async (req, res) => created(res, await service.requestDeletion(ctx(req), req.body)));
export const cancelRequest = asyncHandler(async (req, res) => ok(res, await service.cancelRequest(ctx(req))));

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const approve = asyncHandler(async (req, res) => ok(res, await service.approve(ctx(req), req.params.id, req.body.note)));
export const reject = asyncHandler(async (req, res) => ok(res, await service.reject(ctx(req), req.params.id, req.body.note)));
