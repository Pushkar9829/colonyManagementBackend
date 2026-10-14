import { Router } from 'express';
import { authenticate, requirePlatform } from '../../common/middleware/auth.js';
import { audited } from '../platformTeam/platformAudit.js';
import { validate } from '../../common/middleware/validate.js';
import { authLimiter } from '../../common/middleware/rateLimit.js';
import * as controller from './auth.controller.js';
import * as schema from './auth.validation.js';

const router = Router();

router.post('/register-society', authLimiter, validate({ body: schema.registerSociety }), controller.registerSociety);
router.post('/login', authLimiter, validate({ body: schema.login }), controller.login);
router.post('/otp/request', authLimiter, validate({ body: schema.otpRequest }), controller.requestOtp);
router.post('/otp/verify', authLimiter, validate({ body: schema.otpVerify }), controller.loginWithOtp);
router.post('/refresh', authLimiter, validate({ body: schema.refresh }), controller.refresh);
router.post('/logout', controller.logout);
router.get('/societies/:code', authLimiter, validate({ params: schema.societyCodeParams }), controller.lookupSociety);
router.post('/join', authLimiter, validate({ body: schema.join }), controller.join);

router.post('/password/forgot', authLimiter, validate({ body: schema.forgotPassword }), controller.forgotPassword);
router.post('/password/check', authLimiter, validate({ body: schema.resetToken }), controller.checkResetToken);
router.post('/password/reset', authLimiter, validate({ body: schema.resetPassword }), controller.resetPassword);

router.get('/me', authenticate, controller.me);
router.post('/sessions', authenticate, validate({ body: schema.currentSession }), controller.listSessions);
router.post('/sessions/revoke-others', authenticate, validate({ body: schema.currentSession }), controller.revokeOtherSessions);
router.delete('/sessions/:family', authenticate, validate({ params: schema.sessionParams }), controller.revokeSession);
const supportSessionAudit = audited('support.session_started', { targetType: 'Society', targetId: (req) => req.body.societyId, society: (req) => req.body.societyId });
router.post('/support-session', authenticate, requirePlatform('support.access'), validate({ body: schema.supportSession }), supportSessionAudit, controller.startSupportSession);
router.post('/switch', authenticate, validate({ body: schema.switchMembership }), controller.switchMembership);
router.post('/homes', authenticate, validate({ body: schema.addHome }), controller.addHome);
router.patch('/me', authenticate, validate({ body: schema.updateMe }), controller.updateMe);
router.post('/change-password', authenticate, validate({ body: schema.changePassword }), controller.changePassword);

// Two-step verification. Code-checking endpoints share the auth rate limit; verify also locks per mfaToken.
router.post('/mfa/verify', authLimiter, validate({ body: schema.mfaVerify }), controller.mfaVerify);
router.get('/mfa', authenticate, controller.mfaStatus);
router.post('/mfa/setup', authenticate, controller.mfaSetup);
router.post('/mfa/enable', authLimiter, authenticate, validate({ body: schema.mfaCode }), controller.mfaEnable);
router.post('/mfa/disable', authLimiter, authenticate, validate({ body: schema.mfaDisable }), controller.mfaDisable);
router.post('/mfa/backup-codes', authLimiter, authenticate, validate({ body: schema.mfaCode }), controller.mfaBackupCodes);

export default router;
