import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './events.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  // calendar ranges return the whole month at once
  const pagination = getPagination(q.from || q.to ? { limit: 100, ...q } : q);
  const { items, meta } = await service.list(ctx(req), q, pagination);
  ok(res, items, meta);
});
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const cancel = asyncHandler(async (req, res) => ok(res, await service.cancel(ctx(req), req.params.id, req.body)));

export const rsvp = asyncHandler(async (req, res) => ok(res, await service.rsvp(ctx(req), req.params.id, req.body)));
export const cancelRsvp = asyncHandler(async (req, res) => ok(res, await service.cancelRsvp(ctx(req), req.params.id)));
export const myTicket = asyncHandler(async (req, res) => ok(res, await service.myTicket(ctx(req), req.params.id)));
export const listRsvps = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listRsvps(ctx(req), req.params.id, q, getPagination({ limit: 100, ...q }));
  ok(res, items, meta);
});

export const createOrder = asyncHandler(async (req, res) => ok(res, await service.createOrder(ctx(req), req.params.id)));
export const verify = asyncHandler(async (req, res) => ok(res, await service.verifyPayment(ctx(req), req.body)));
export const mockSign = asyncHandler(async (req, res) => ok(res, await service.mockSign(req.body.orderId, req.user.society)));
export const collect = asyncHandler(async (req, res) => ok(res, await service.collectAtVenue(ctx(req), req.params.id, req.params.rsvpId, req.body)));
export const listTickets = asyncHandler(async (req, res) => {
  const { items, meta } = await service.listTickets(ctx(req), req.params.id, getPagination(query(req)));
  ok(res, items, meta);
});

export const checkIn = asyncHandler(async (req, res) => ok(res, await service.checkIn(ctx(req), req.params.id, req.body)));
export const undoCheckIn = asyncHandler(async (req, res) => ok(res, await service.undoCheckIn(ctx(req), req.params.id, req.params.rsvpId)));

export const addPhotos = asyncHandler(async (req, res) => ok(res, await service.addPhotos(ctx(req), req.params.id, req.body)));
export const removePhoto = asyncHandler(async (req, res) => ok(res, await service.removePhoto(ctx(req), req.params.id, req.params.photoId)));
