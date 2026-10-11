import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './meters.service.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const listMeters = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listMeters(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const getMeter = asyncHandler(async (req, res) => ok(res, await service.getMeter(ctx(req), req.params.id)));
export const createMeter = asyncHandler(async (req, res) => created(res, await service.createMeter(ctx(req), req.body)));
export const updateMeter = asyncHandler(async (req, res) => ok(res, await service.updateMeter(ctx(req), req.params.id, req.body)));
export const replaceMeter = asyncHandler(async (req, res) => created(res, await service.replaceMeter(ctx(req), req.params.id, req.body)));

export const listReadings = asyncHandler(async (req, res) => {
  const { items, meta } = await service.listReadings(ctx(req), req.params.id, getPagination(query(req)));
  ok(res, items, meta);
});
export const addReading = asyncHandler(async (req, res) => created(res, await service.recordReading(ctx(req), req.params.id, req.body)));
export const deleteReading = asyncHandler(async (req, res) => {
  await service.deleteReading(ctx(req), req.params.id);
  noContent(res);
});
export const bulkReadings = asyncHandler(async (req, res) => ok(res, await service.bulkReadings(ctx(req), req.body)));
export const importReadings = asyncHandler(async (req, res) => ok(res, await service.importReadings(ctx(req), req.file)));
export const deviceReadings = asyncHandler(async (req, res) => {
  const items = req.body.readings || [req.body];
  ok(res, await service.deviceReadings(ctx(req), req.device, items));
});

export const sheet = asyncHandler(async (req, res) => ok(res, await service.sheet(ctx(req), query(req))));
export const sheetXlsx = asyncHandler(async (req, res) => {
  const buf = await service.sheetWorkbook(ctx(req), query(req));
  res.set({ 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="meter-readings-${query(req).period}.xlsx"` }).send(buf);
});
export const consumption = asyncHandler(async (req, res) => ok(res, await service.consumption(ctx(req), query(req))));

export const listTariffs = asyncHandler(async (req, res) => ok(res, await service.listTariffs(ctx(req))));
export const createTariff = asyncHandler(async (req, res) => created(res, await service.createTariff(ctx(req), req.body)));
export const updateTariff = asyncHandler(async (req, res) => ok(res, await service.updateTariff(ctx(req), req.params.id, req.body)));
