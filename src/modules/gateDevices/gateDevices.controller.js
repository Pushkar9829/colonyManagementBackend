import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './gateDevices.service.js';

// Hardware calls carry the device id so movements and acks record which device acted.
const deviceCtx = (req) => ({ ...ctx(req), deviceId: req.device._id });

export const event = asyncHandler(async (req, res) => {
  const r = await service.handleEvent(deviceCtx(req), req.body);
  return r.duplicate ? ok(res, r) : created(res, r);
});
export const poll = asyncHandler(async (req, res) => ok(res, await service.pollCommands(deviceCtx(req), query(req))));
export const ack = asyncHandler(async (req, res) => ok(res, await service.ackCommand(deviceCtx(req), req.params.id, req.body)));

export const requestOpen = asyncHandler(async (req, res) => created(res, await service.requestOpen(ctx(req), req.body)));
export const listCommands = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listCommands(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const gates = asyncHandler(async (req, res) => ok(res, await service.gates(ctx(req))));
