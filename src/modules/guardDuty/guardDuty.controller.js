import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './guardDuty.service.js';

const paged = (fn) =>
  asyncHandler(async (req, res) => {
    const q = query(req);
    const { items, meta } = await fn(ctx(req), q, getPagination(q));
    ok(res, items, meta);
  });

export const listHandovers = paged(service.listHandovers);
export const createHandover = asyncHandler(async (req, res) => created(res, await service.createHandover(ctx(req), req.body)));
export const acknowledgeHandover = asyncHandler(async (req, res) => ok(res, await service.acknowledgeHandover(ctx(req), req.params.id, req.body)));

export const listIncidents = paged(service.listIncidents);
export const createIncident = asyncHandler(async (req, res) => created(res, await service.createIncident(ctx(req), req.body)));
export const getIncident = asyncHandler(async (req, res) => ok(res, await service.getIncident(ctx(req), req.params.id)));
export const closeIncident = asyncHandler(async (req, res) => ok(res, await service.closeIncident(ctx(req), req.params.id, req.body)));

export const occurrenceBook = asyncHandler(async (req, res) => ok(res, await service.occurrenceBook(ctx(req), query(req))));
export const addOccurrence = asyncHandler(async (req, res) => created(res, await service.addOccurrence(ctx(req), req.body)));
export const guards = asyncHandler(async (req, res) => ok(res, await service.guards(ctx(req))));
