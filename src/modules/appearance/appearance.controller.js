import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import * as service from './appearance.service.js';

// public / members
export const publicAppearance = asyncHandler(async (req, res) => {
  // the login page asks on every visit; a short browser cache keeps that cheap
  res.set('Cache-Control', 'public, max-age=60');
  ok(res, await service.forPublic(query(req)));
});
export const mine = asyncHandler(async (req, res) => ok(res, await service.forMember(req.user.society)));

// colony admin
export const options = asyncHandler(async (req, res) => ok(res, await service.options(ctx(req))));
export const preview = asyncHandler(async (req, res) => ok(res, await service.preview(ctx(req), req.params.key)));
export const apply = asyncHandler(async (req, res) => ok(res, await service.apply(ctx(req), req.body.template)));
export const setMedia = asyncHandler(async (req, res) => ok(res, await service.setMedia(ctx(req), req.body)));

// platform console
export const overview = asyncHandler(async (_req, res) => ok(res, await service.platformOverview()));
export const setEnabled = asyncHandler(async (req, res) => ok(res, await service.setEnabled(req.user, req.params.key, req.body.enabled)));
export const setDefault = asyncHandler(async (req, res) => ok(res, await service.setDefault(req.user, req.body.template)));
export const setPlanRule = asyncHandler(async (req, res) => ok(res, await service.setPlanRule(req.user, req.params.plan, req.body.templates)));
export const societyGet = asyncHandler(async (req, res) => ok(res, await service.forPlatformSociety(req.params.id)));
export const societyUpdate = asyncHandler(async (req, res) => ok(res, await service.updatePlatformSociety(req.user, req.params.id, req.body)));
export const resellerGet = asyncHandler(async (req, res) => ok(res, await service.forPlatformReseller(req.params.id)));
export const resellerUpdate = asyncHandler(async (req, res) => ok(res, await service.updatePlatformReseller(req.user, req.params.id, req.body)));
