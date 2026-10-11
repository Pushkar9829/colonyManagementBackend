import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './builder.service.js';

const listed = (res, { items, meta }) => ok(res, items, meta);
const page = (fn) =>
  asyncHandler(async (req, res) => {
    const q = query(req);
    listed(res, await fn(ctx(req), q, getPagination(q)));
  });

export const listPossessions = page(service.listPossessions);
export const schedulePossession = asyncHandler(async (req, res) => created(res, await service.schedulePossession(ctx(req), req.body)));
export const updatePossession = asyncHandler(async (req, res) => ok(res, await service.updatePossession(ctx(req), req.params.id, req.body)));
export const completePossession = asyncHandler(async (req, res) => ok(res, await service.completePossession(ctx(req), req.params.id, req.body)));
export const cancelPossession = asyncHandler(async (req, res) => ok(res, await service.cancelPossession(ctx(req), req.params.id, req.body)));

export const listSnags = page(service.listSnags);
export const snagSummary = asyncHandler(async (req, res) => ok(res, await service.snagSummary(ctx(req))));
export const createSnag = asyncHandler(async (req, res) => created(res, await service.createSnag(ctx(req), req.body)));
export const getSnag = asyncHandler(async (req, res) => ok(res, await service.getSnag(ctx(req), req.params.id)));
export const updateSnag = asyncHandler(async (req, res) => ok(res, await service.updateSnag(ctx(req), req.params.id, req.body)));
export const signOffSnag = asyncHandler(async (req, res) => ok(res, await service.signOffSnag(ctx(req), req.params.id, req.body)));
export const reopenSnag = asyncHandler(async (req, res) => ok(res, await service.reopenSnag(ctx(req), req.params.id, req.body)));

export const listProgress = page(service.listProgress);
export const postProgress = asyncHandler(async (req, res) => created(res, await service.postProgress(ctx(req), req.body)));
export const removeProgress = asyncHandler(async (req, res) => {
  await service.removeProgress(ctx(req), req.params.id);
  noContent(res);
});

export const getHandover = asyncHandler(async (req, res) => ok(res, await service.getHandover(ctx(req))));
export const addHandoverItem = asyncHandler(async (req, res) => created(res, await service.addHandoverItem(ctx(req), req.body)));
export const updateHandoverItem = asyncHandler(async (req, res) => ok(res, await service.updateHandoverItem(ctx(req), req.params.itemId, req.body)));
export const removeHandoverItem = asyncHandler(async (req, res) => ok(res, await service.removeHandoverItem(ctx(req), req.params.itemId)));
export const signHandover = asyncHandler(async (req, res) => ok(res, await service.signHandover(ctx(req), req.body)));
export const handoverPdf = asyncHandler(async (req, res) => {
  const { filename, buffer } = await service.handoverPdfFile(ctx(req));
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.send(buffer);
});
