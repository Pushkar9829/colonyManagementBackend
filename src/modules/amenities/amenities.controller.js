import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './amenities.service.js';
import * as passes from './passes.service.js';
import * as reports from './reports.service.js';

export const listAmenities = asyncHandler(async (req, res) => ok(res, await service.listAmenities(ctx(req))));
export const createAmenity = asyncHandler(async (req, res) => created(res, await service.createAmenity(ctx(req), req.body)));
export const updateAmenity = asyncHandler(async (req, res) => ok(res, await service.updateAmenity(ctx(req), req.params.id, req.body)));
export const addPhotos = asyncHandler(async (req, res) => ok(res, await service.addPhotos(ctx(req), req.params.id, req.body.files)));
export const removePhoto = asyncHandler(async (req, res) => ok(res, await service.removePhoto(ctx(req), req.params.id, req.params.photoId)));
export const availability = asyncHandler(async (req, res) => ok(res, await service.availability(ctx(req), req.params.id, query(req).date)));
export const verifyPayment = asyncHandler(async (req, res) => ok(res, await service.verifyPayment(ctx(req), req.body)));

export const usageReport = asyncHandler(async (req, res) => ok(res, await reports.usage(ctx(req), query(req))));
export const usageExport = asyncHandler(async (req, res) => {
  const { buffer, filename } = await reports.usageWorkbook(ctx(req), query(req));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
});

export const createBooking = asyncHandler(async (req, res) => created(res, await service.createBooking(ctx(req), req.body)));
export const listBookings = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listBookings(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const getBooking = asyncHandler(async (req, res) => ok(res, await service.getBooking(ctx(req), req.params.id)));
export const quote = asyncHandler(async (req, res) => ok(res, await service.quote(ctx(req), req.params.id)));
export const cancelBooking = asyncHandler(async (req, res) => ok(res, await service.cancelBooking(ctx(req), req.params.id, req.body?.reason)));
export const decide = asyncHandler(async (req, res) => ok(res, await service.decide(ctx(req), req.params.id, req.body)));
export const payBooking = asyncHandler(async (req, res) => ok(res, await service.payBooking(ctx(req), req.params.id)));
export const markBookingPaid = asyncHandler(async (req, res) => ok(res, await service.markBookingPaid(ctx(req), req.params.id, req.body)));
export const refundDeposit = asyncHandler(async (req, res) => ok(res, await service.refundDeposit(ctx(req), req.params.id, req.body)));
export const markAttendance = asyncHandler(async (req, res) => ok(res, await service.markAttendance(ctx(req), req.params.id, req.body.attended)));

export const listPlans = asyncHandler(async (req, res) => ok(res, await passes.listPlans(ctx(req), req.params.id || query(req).amenity)));
export const createPlan = asyncHandler(async (req, res) => created(res, await passes.createPlan(ctx(req), req.params.id, req.body)));
export const updatePlan = asyncHandler(async (req, res) => ok(res, await passes.updatePlan(ctx(req), req.params.planId, req.body)));

export const buyPass = asyncHandler(async (req, res) => created(res, await passes.buy(ctx(req), req.body)));
export const listPasses = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await passes.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const getPass = asyncHandler(async (req, res) => ok(res, await passes.getById(ctx(req), req.params.id)));
export const payPass = asyncHandler(async (req, res) => ok(res, await passes.payPass(ctx(req), req.params.id)));
export const markPassPaid = asyncHandler(async (req, res) => ok(res, await passes.markPassPaid(ctx(req), req.params.id, req.body)));
export const cancelPass = asyncHandler(async (req, res) => ok(res, await passes.cancelPass(ctx(req), req.params.id, req.body)));
export const checkPass = asyncHandler(async (req, res) => ok(res, await passes.check(ctx(req), req.body)));
