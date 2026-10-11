import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './marketplace.service.js';

const listed = (fn) =>
  asyncHandler(async (req, res) => {
    const q = query(req);
    const { items, meta } = await fn(ctx(req), q, getPagination(q));
    ok(res, items, meta);
  });

export const listListings = listed(service.listListings);
export const createListing = asyncHandler(async (req, res) => created(res, await service.createListing(ctx(req), req.body)));
export const getListing = asyncHandler(async (req, res) => ok(res, await service.getListing(ctx(req), req.params.id)));
export const updateListing = asyncHandler(async (req, res) => ok(res, await service.updateListing(ctx(req), req.params.id, req.body)));
export const setListingStatus = asyncHandler(async (req, res) => ok(res, await service.setListingStatus(ctx(req), req.params.id, req.body)));
export const deleteListing = asyncHandler(async (req, res) => {
  await service.deleteListing(ctx(req), req.params.id, req.body?.reason);
  noContent(res);
});
export const reportListing = asyncHandler(async (req, res) => created(res, await service.reportListing(ctx(req), req.params.id, req.body)));
export const contactSeller = asyncHandler(async (req, res) => ok(res, await service.contactSeller(ctx(req), req.params.id, req.body)));
export const listReports = listed(service.listReports);
export const resolveReport = asyncHandler(async (req, res) => ok(res, await service.resolveReport(ctx(req), req.params.id, req.body)));

export const listBusinesses = listed(service.listBusinesses);
export const createBusiness = asyncHandler(async (req, res) => created(res, await service.createBusiness(ctx(req), req.body)));
export const updateBusiness = asyncHandler(async (req, res) => ok(res, await service.updateBusiness(ctx(req), req.params.id, req.body)));
export const reviewBusiness = asyncHandler(async (req, res) => ok(res, await service.reviewBusiness(ctx(req), req.params.id, req.body)));
export const deleteBusiness = asyncHandler(async (req, res) => {
  await service.deleteBusiness(ctx(req), req.params.id);
  noContent(res);
});
export const contactBusiness = asyncHandler(async (req, res) => ok(res, await service.contactBusiness(ctx(req), req.params.id, req.body)));
