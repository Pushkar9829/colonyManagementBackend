import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import logger from '../../common/utils/logger.js';
import * as service from './reports.service.js';

export const catalogue = asyncHandler(async (req, res) => ok(res, service.catalogue(ctx(req))));

// Streams the file. Validation and permission errors happen in prepare(), before any byte is sent;
// a failure mid-stream can only abort the connection (the client sees a broken download).
export const exportReport = asyncHandler(async (req, res) => {
  const job = await service.prepare(ctx(req), req.params.key, query(req));
  res.status(200).set({
    'Content-Type': job.format.contentType,
    'Content-Disposition': `attachment; filename="${job.filename}"`,
    'Cache-Control': 'no-store',
    'Access-Control-Expose-Headers': 'Content-Disposition',
  });
  try {
    await job.format.write(res, job.report, job.rows, { title: job.title, subtitle: job.subtitle });
  } catch (err) {
    logger.error({ err, report: req.params.key }, 'report export failed mid-stream');
    res.destroy(err);
  }
});

export const listSchedules = asyncHandler(async (req, res) => ok(res, await service.listSchedules(ctx(req))));
export const createSchedule = asyncHandler(async (req, res) => created(res, await service.createSchedule(ctx(req), req.body)));
export const updateSchedule = asyncHandler(async (req, res) => ok(res, await service.updateSchedule(ctx(req), req.params.id, req.body)));
export const removeSchedule = asyncHandler(async (req, res) => {
  await service.removeSchedule(ctx(req), req.params.id);
  noContent(res);
});
export const sendNow = asyncHandler(async (req, res) => ok(res, await service.sendNow(ctx(req), req.params.id)));
export const preview = asyncHandler(async (req, res) => ok(res, await service.preview(ctx(req), query(req).frequency)));
