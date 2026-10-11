import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './assets.service.js';
import * as fire from './fireSafety.service.js';

const paged = (fn) =>
  asyncHandler(async (req, res) => {
    const q = query(req);
    const { items, meta } = await fn(req, q, getPagination(q));
    ok(res, items, meta);
  });

export const list = paged((req, q, p) => service.list(ctx(req), q, p));
export const stats = asyncHandler(async (req, res) => ok(res, await service.stats(ctx(req))));
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const getByCode = asyncHandler(async (req, res) => ok(res, await service.getByCode(ctx(req), req.params.code)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const changeStatus = asyncHandler(async (req, res) => ok(res, await service.changeStatus(ctx(req), req.params.id, req.body)));
export const addFiles = asyncHandler(async (req, res) => ok(res, await service.addFiles(ctx(req), req.params.id, req.body)));
export const removeFile = asyncHandler(async (req, res) => ok(res, await service.removeFile(ctx(req), req.params.id, req.body)));
export const setAmc = asyncHandler(async (req, res) => ok(res, await service.setAmc(ctx(req), req.params.id, req.body)));
export const addAmcVisit = asyncHandler(async (req, res) => created(res, await service.addAmcVisit(ctx(req), req.params.id, req.body)));
export const listAmcVisits = asyncHandler(async (req, res) => ok(res, await service.listAmcVisits(ctx(req), req.params.id)));
export const addEvent = asyncHandler(async (req, res) => created(res, await service.addServiceEvent(ctx(req), req.params.id, req.body)));
export const timeline = paged((req, q, p) => service.timeline(ctx(req), req.params.id, p));

export const fireSummary = asyncHandler(async (req, res) => ok(res, await fire.summary(ctx(req))));
export const listExtinguishers = paged((req, q, p) => fire.listExtinguishers(ctx(req), q, p));
export const createExtinguisher = asyncHandler(async (req, res) => created(res, await fire.createExtinguisher(ctx(req), req.body)));
export const updateExtinguisher = asyncHandler(async (req, res) => ok(res, await fire.updateExtinguisher(ctx(req), req.params.id, req.body)));
export const refillExtinguisher = asyncHandler(async (req, res) => ok(res, await fire.refillExtinguisher(ctx(req), req.params.id, req.body)));
export const listDrills = paged((req, q, p) => fire.listDrills(ctx(req), p));
export const createDrill = asyncHandler(async (req, res) => created(res, await fire.createDrill(ctx(req), req.body)));
export const listNocs = asyncHandler(async (req, res) => ok(res, await fire.listNocs(ctx(req))));
export const createNoc = asyncHandler(async (req, res) => created(res, await fire.createNoc(ctx(req), req.body)));
