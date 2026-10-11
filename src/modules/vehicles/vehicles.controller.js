import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './vehicles.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const remove = asyncHandler(async (req, res) => {
  await service.remove(ctx(req), req.params.id);
  noContent(res);
});
export const setRfid = asyncHandler(async (req, res) => ok(res, await service.setRfidTag(ctx(req), req.params.id, req.body.rfidTag)));

export const listMovements = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listMovements(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const logMovement = asyncHandler(async (req, res) => created(res, await service.logManual(ctx(req), req.body)));
export const lookup = asyncHandler(async (req, res) => {
  const { plate, direction } = query(req);
  const e = await service.evaluate(ctx(req).societyId, { plate, direction });
  ok(res, {
    plate: e.plate,
    match: e.match,
    decision: e.decision,
    reason: e.reason,
    vehicle: e.vehicle && { _id: e.vehicle._id, number: e.vehicle.number, type: e.vehicle.type, make: e.vehicle.make, color: e.vehicle.color, unit: e.vehicle.unit },
    visitor: e.visitor && { _id: e.visitor._id, name: e.visitor.name, unit: e.visitor.unit },
  });
});
