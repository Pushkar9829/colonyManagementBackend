import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx } from '../../common/utils/context.js';
import * as service from './committee.service.js';

export const me = asyncHandler(async (req, res) => ok(res, await service.myAccess(ctx(req))));
export const current = asyncHandler(async (req, res) => ok(res, await service.current(ctx(req))));
export const listTerms = asyncHandler(async (req, res) => ok(res, await service.listTerms(ctx(req))));
export const signatories = asyncHandler(async (req, res) => ok(res, await service.signatories(req.user.society)));
export const createTerm = asyncHandler(async (req, res) => created(res, await service.createTerm(ctx(req), req.body)));
export const updateTerm = asyncHandler(async (req, res) => ok(res, await service.updateTerm(ctx(req), req.params.id, req.body)));
export const activateTerm = asyncHandler(async (req, res) => ok(res, await service.activateTerm(ctx(req), req.params.id)));
export const dissolveTerm = asyncHandler(async (req, res) => ok(res, await service.dissolveTerm(ctx(req), req.params.id)));
export const addPosition = asyncHandler(async (req, res) => created(res, await service.addPosition(ctx(req), req.params.id, req.body)));
export const updatePosition = asyncHandler(async (req, res) => ok(res, await service.updatePosition(ctx(req), req.params.id, req.params.positionId, req.body)));
export const endPosition = asyncHandler(async (req, res) => ok(res, await service.endPosition(ctx(req), req.params.id, req.params.positionId, req.body)));
export const removePosition = asyncHandler(async (req, res) => ok(res, await service.removePosition(ctx(req), req.params.id, req.params.positionId)));
export const termFromElection = asyncHandler(async (req, res) => created(res, await service.termFromElection(ctx(req), req.body)));
