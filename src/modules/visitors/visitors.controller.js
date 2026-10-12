import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './visitors.service.js';
import * as watchlist from './watchlist.service.js';
import * as gateSync from './gateSync.service.js';
import * as analytics from './analytics.service.js';
import * as settings from './securitySettings.service.js';

const paged = (fn) =>
  asyncHandler(async (req, res) => {
    const q = query(req);
    const { items, meta } = await fn(ctx(req), q, getPagination(q));
    ok(res, items, meta);
  });

export const logEntry = asyncHandler(async (req, res) => {
  const v = await service.logEntry(ctx(req), req.body);
  // A retried request with the same key answers 200 with the original entry.
  if (v.duplicate) return ok(res, v);
  return created(res, v);
});
export const list = paged(service.list);
export const approve = asyncHandler(async (req, res) => ok(res, await service.respond(ctx(req), req.params.id, true, req.body?.note)));
export const deny = asyncHandler(async (req, res) => ok(res, await service.respond(ctx(req), req.params.id, false, req.body?.note)));
export const guardCheckIn = asyncHandler(async (req, res) => ok(res, await service.guardCheckIn(ctx(req), req.params.id, req.body?.note)));
export const guardSendBack = asyncHandler(async (req, res) => ok(res, await service.guardSendBack(ctx(req), req.params.id, req.body?.note)));
export const checkOut = asyncHandler(async (req, res) => ok(res, await service.checkOut(ctx(req), req.params.id, { occurredAt: req.body?.occurredAt })));
export const contacts = asyncHandler(async (req, res) => ok(res, await service.householdContacts(ctx(req), req.params.id)));

export const createPass = asyncHandler(async (req, res) => created(res, await service.createPass(ctx(req), req.body)));
export const listPasses = paged(service.listPasses);
export const cancelPass = asyncHandler(async (req, res) => ok(res, await service.cancelPass(ctx(req), req.params.id)));
export const verifyPass = asyncHandler(async (req, res) => {
  const { code, ...opts } = req.body;
  const v = await service.verifyPass(ctx(req), code, opts);
  if (v.duplicate) return ok(res, v);
  return created(res, v);
});

export const listWatch = paged(watchlist.list);
export const createWatch = asyncHandler(async (req, res) => created(res, await watchlist.create(ctx(req), req.body)));
export const updateWatch = asyncHandler(async (req, res) => ok(res, await watchlist.update(ctx(req), req.params.id, req.body)));
export const removeWatch = asyncHandler(async (req, res) => {
  await watchlist.remove(ctx(req), req.params.id);
  noContent(res);
});
export const checkWatch = asyncHandler(async (req, res) => ok(res, await watchlist.check(ctx(req), req.body)));

export const listFrequent = paged(service.listFrequent);
export const createFrequent = asyncHandler(async (req, res) => created(res, await service.createFrequent(ctx(req), req.body)));
export const updateFrequent = asyncHandler(async (req, res) => ok(res, await service.updateFrequent(ctx(req), req.params.id, req.body)));
export const removeFrequent = asyncHandler(async (req, res) => {
  await service.removeFrequent(ctx(req), req.params.id);
  noContent(res);
});
export const frequentPass = asyncHandler(async (req, res) => created(res, await service.passForFrequent(ctx(req), req.params.id, req.body)));

export const sync = asyncHandler(async (req, res) => ok(res, await gateSync.sync(ctx(req), req.body.ops)));

export const analyticsSummary = asyncHandler(async (req, res) => ok(res, await analytics.summary(ctx(req), query(req))));
export const analyticsExport = asyncHandler(async (req, res) => {
  const { buffer, filename } = await analytics.exportWorkbook(ctx(req), query(req));
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.send(Buffer.from(buffer));
});

export const getSettings = asyncHandler(async (req, res) => ok(res, await settings.getSettings(ctx(req).societyId)));
export const updateSettings = asyncHandler(async (req, res) => ok(res, await settings.updateSettings(ctx(req), req.body)));
