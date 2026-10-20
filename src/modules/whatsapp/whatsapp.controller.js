import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './whatsapp.service.js';

const platformCtx = (req) => ({ userId: req.user._id, ip: req.ip });

export const mine = asyncHandler(async (req, res) => ok(res, await service.forSociety(ctx(req))));

export const platformSummary = asyncHandler(async (req, res) => ok(res, await service.platformSummary(req.params.id)));
export const updateAccount = asyncHandler(async (req, res) => ok(res, await service.setMode(platformCtx(req), req.params.id, req.body)));
export const grantCredits = asyncHandler(async (req, res) => created(res, await service.grantCredits(platformCtx(req), req.params.id, req.body)));
export const ledger = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.ledger(req.params.id, q, getPagination(q));
  ok(res, items, meta);
});
