import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './elections.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const transition = asyncHandler(async (req, res) => ok(res, await service.transition(ctx(req), req.params.id, req.params.action, req.body)));
export const results = asyncHandler(async (req, res) => ok(res, await service.results(ctx(req), req.params.id)));
export const resolveTie = asyncHandler(async (req, res) => ok(res, await service.resolveTie(ctx(req), req.params.id, req.body)));
export const publish = asyncHandler(async (req, res) => ok(res, await service.publish(ctx(req), req.params.id)));
export const turnout = asyncHandler(async (req, res) => ok(res, await service.turnout(ctx(req), req.params.id)));

export const listNominations = asyncHandler(async (req, res) => ok(res, await service.listNominations(ctx(req), req.params.id)));
export const eligibleCandidates = asyncHandler(async (req, res) => ok(res, await service.eligibleCandidates(ctx(req), req.params.id)));
export const nominate = asyncHandler(async (req, res) => created(res, await service.nominate(ctx(req), req.params.id, req.body)));
export const respond = asyncHandler(async (req, res) => ok(res, await service.respondNomination(ctx(req), req.params.id, req.params.nominationId, req.body.accept)));
export const withdraw = asyncHandler(async (req, res) => ok(res, await service.withdrawNomination(ctx(req), req.params.id, req.params.nominationId)));
export const scrutinize = asyncHandler(async (req, res) => ok(res, await service.scrutinize(ctx(req), req.params.id, req.params.nominationId, req.body)));

export const voteCode = asyncHandler(async (req, res) => ok(res, await service.requestVoteCode(ctx(req), req.params.id)));
export const vote = asyncHandler(async (req, res) => created(res, await service.castVote(ctx(req), req.params.id, req.body)));
export const verify = asyncHandler(async (req, res) => ok(res, await service.verifyBallot(ctx(req), req.params.id, query(req).tracker)));
