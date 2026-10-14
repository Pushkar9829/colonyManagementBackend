import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import * as service from './gates.service.js';

export const list = asyncHandler(async (req, res) => ok(res, await service.list(ctx(req), query(req))));
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body)));
export const reorder = asyncHandler(async (req, res) => ok(res, await service.reorder(ctx(req), req.body.ids)));
export const remove = asyncHandler(async (req, res) => ok(res, await service.remove(ctx(req), req.params.id)));

export const myPost = asyncHandler(async (req, res) => ok(res, await service.myPost(ctx(req))));
export const setPost = asyncHandler(async (req, res) => ok(res, await service.setPost(ctx(req), req.body.gateId)));
