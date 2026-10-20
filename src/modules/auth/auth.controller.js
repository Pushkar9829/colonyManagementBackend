import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx } from '../../common/utils/context.js';
import * as service from './auth.service.js';
import * as passwords from './password.service.js';
import * as sessions from './sessions.service.js';
import * as mfa from './mfa.service.js';
import { actingProfile } from '../loginAs/acting.js';

const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

export const registerSociety = asyncHandler(async (req, res) => created(res, await service.registerSociety(req.body, meta(req))));
export const login = asyncHandler(async (req, res) => ok(res, await service.login(req.body, meta(req))));
export const refresh = asyncHandler(async (req, res) => ok(res, await service.refresh(req.body.refreshToken, meta(req))));
export const logout = asyncHandler(async (req, res) => {
  await service.logout(req.body?.refreshToken);
  ok(res, { loggedOut: true });
});
export const lookupSociety = asyncHandler(async (req, res) => ok(res, await service.lookupSociety(req.params.code)));
export const join = asyncHandler(async (req, res) => created(res, await service.join(req.body)));
export const me = asyncHandler(async (req, res) => ok(res, actingProfile(req.user, await service.profile(req.user._id, req.user.membershipId))));
export const switchMembership = asyncHandler(async (req, res) => ok(res, await service.switchMembership(ctx(req), req.body.membershipId, meta(req))));
export const addHome = asyncHandler(async (req, res) => created(res, await service.addHome(ctx(req), req.body)));
export const updateMe = asyncHandler(async (req, res) => ok(res, await service.updateMe(ctx(req), req.body)));
export const changePassword = asyncHandler(async (req, res) => {
  await service.changePassword(ctx(req), req.body);
  ok(res, { changed: true });
});
export const requestOtp = asyncHandler(async (req, res) => ok(res, await service.requestOtp(req.body)));
export const loginWithOtp = asyncHandler(async (req, res) => ok(res, await service.loginWithOtp(req.body, meta(req))));

export const forgotPassword = asyncHandler(async (req, res) => ok(res, await passwords.requestReset(req.body.email)));
export const checkResetToken = asyncHandler(async (req, res) => ok(res, await passwords.checkToken(req.body.token)));
export const resetPassword = asyncHandler(async (req, res) => ok(res, await passwords.resetPassword(req.body.token, req.body.password)));

export const listSessions = asyncHandler(async (req, res) => ok(res, await sessions.list(ctx(req), req.body?.refreshToken)));
export const revokeSession = asyncHandler(async (req, res) => {
  await sessions.revoke(ctx(req), req.params.family);
  ok(res, { revoked: true });
});
export const revokeOtherSessions = asyncHandler(async (req, res) => {
  await sessions.revokeOthers(ctx(req), req.body?.refreshToken);
  ok(res, { revoked: true });
});

// Platform owner opens a time-limited admin session in a society for support.
export const startSupportSession = asyncHandler(async (req, res) => {
  const m = await sessions.startSupportSession(ctx(req), req.body.societyId, req.body.reason);
  ok(res, await service.switchMembership(ctx(req), m._id, meta(req)));
});

// Two-step verification (TOTP authenticator app + backup codes).
export const mfaStatus = asyncHandler(async (req, res) => ok(res, await mfa.status(ctx(req))));
export const mfaSetup = asyncHandler(async (req, res) => ok(res, await mfa.setup(ctx(req))));
export const mfaEnable = asyncHandler(async (req, res) => ok(res, await mfa.enable(ctx(req), req.body.code)));
export const mfaDisable = asyncHandler(async (req, res) => ok(res, await mfa.disable(ctx(req), req.body)));
export const mfaBackupCodes = asyncHandler(async (req, res) => ok(res, await mfa.regenerateBackupCodes(ctx(req), req.body.code)));
export const mfaVerify = asyncHandler(async (req, res) => ok(res, await service.loginWithMfa(req.body, meta(req))));
