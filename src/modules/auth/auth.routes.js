import { Router } from 'express';
import { authenticate, requirePlatformAdmin } from '../../common/middleware/auth.js';
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
router.post('/support-session', authenticate, requirePlatformAdmin, validate({ body: schema.supportSession }), controller.startSupportSession);
router.post('/switch', authenticate, validate({ body: schema.switchMembership }), controller.switchMembership);
router.post('/homes', authenticate, validate({ body: schema.addHome }), controller.addHome);
router.patch('/me', authenticate, validate({ body: schema.updateMe }), controller.updateMe);
router.post('/change-password', authenticate, validate({ body: schema.changePassword }), controller.changePassword);

export default router;
