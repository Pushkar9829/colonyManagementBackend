import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './parking.service.js';

const paged = (fn) =>
  asyncHandler(async (req, res) => {
    const q = query(req);
    const { items, meta } = await fn(ctx(req), q, getPagination(q));
    ok(res, items, meta);
  });
const one = (fn, status = ok) => asyncHandler(async (req, res) => status(res, await fn(ctx(req), req.params.id, req.body)));
const make = (fn) => asyncHandler(async (req, res) => created(res, await fn(ctx(req), req.body)));
const gone = (fn) =>
  asyncHandler(async (req, res) => {
    await fn(ctx(req), req.params.id);
    noContent(res);
  });

export const listAreas = asyncHandler(async (req, res) => ok(res, await service.listAreas(ctx(req))));
export const createArea = make(service.createArea);
export const updateArea = one(service.updateArea);
export const removeArea = gone(service.removeArea);

export const listSlots = paged(service.listSlots);
export const createSlots = make(service.createSlots);
export const updateSlot = one(service.updateSlot);
export const removeSlot = gone(service.removeSlot);
export const allot = one(service.allot);
export const release = asyncHandler(async (req, res) => ok(res, await service.release(ctx(req), req.params.id)));
export const mine = asyncHandler(async (req, res) => ok(res, await service.mine(ctx(req))));
export const summary = asyncHandler(async (req, res) => ok(res, await service.summary(ctx(req))));

export const listVisitor = paged(service.listVisitorParking);
export const startVisitor = make(service.startVisitorParking);
export const endVisitor = asyncHandler(async (req, res) => ok(res, await service.endVisitorParking(ctx(req), req.params.id)));

export const listViolations = paged(service.listViolations);
export const reportViolation = make(service.reportViolation);
export const dispute = one(service.disputeViolation);
export const resolveViolation = one(service.resolveViolation);

export const listChargers = asyncHandler(async (req, res) => ok(res, await service.listChargers(ctx(req), query(req))));
export const createCharger = make(service.createCharger);
export const updateCharger = one(service.updateCharger);
export const availability = asyncHandler(async (req, res) => ok(res, await service.availability(ctx(req), req.params.id, query(req).date)));
export const listBookings = paged(service.listBookings);
export const book = make(service.book);
export const start = asyncHandler(async (req, res) => ok(res, await service.startCharging(ctx(req), req.params.id)));
export const complete = one(service.completeCharging);
export const cancel = one(service.cancelBooking);
