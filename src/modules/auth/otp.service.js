import crypto from 'node:crypto';
import env from '../../config/env.js';
import ApiError from '../../common/errors/ApiError.js';
import { numericCode } from '../../common/utils/codes.js';
import { sms } from '../../integrations/sms.js';
import Otp from './otp.model.js';
import User from '../users/user.model.js';

const TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

// HMAC with the server secret so a leaked database doesn't reveal 6-digit codes by brute force.
const hashCode = (phone, code) => crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${phone}:${code}`).digest('hex');

const GENERIC = 'If this number is registered, a login code has been sent by SMS.';

export async function requestLoginOtp(phone) {
  const now = Date.now();
  const existing = await Otp.findOne({ phone, purpose: 'login' });
  if (existing && now - existing.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.lastSentAt.getTime())) / 1000);
    throw new ApiError(429, 'OTP_COOLDOWN', 'Please wait {seconds}s before requesting another code', { params: { seconds: wait } });
  }
  const windowFresh = !existing || now - existing.windowStartedAt.getTime() > 3600 * 1000;
  if (!windowFresh && existing.sendCount >= MAX_SENDS_PER_HOUR) {
    throw new ApiError(429, 'OTP_LIMIT', 'Too many codes requested. Try again in an hour or log in with your password.');
  }

  // Respond the same way for unknown numbers so the endpoint can't be used to discover residents.
  const user = await User.findOne({ phone, status: 'active' }).select('_id').lean();
  if (!user) return { message: GENERIC };

  const code = numericCode(6);
  await Otp.findOneAndUpdate(
    { phone, purpose: 'login' },
    {
      codeHash: hashCode(phone, code),
      expiresAt: new Date(now + TTL_MS),
      attempts: 0,
      lastSentAt: new Date(now),
      ...(windowFresh ? { sendCount: 1, windowStartedAt: new Date(now) } : { $inc: { sendCount: 1 } }),
    },
    { upsert: true },
  );
  await sms.send(phone, `${code} is your ColonyHub login code. It expires in 5 minutes. Do not share it.`);
  // Dev convenience: with the console SMS provider there is no phone, so hand the code back.
  return { message: GENERIC, ...(sms.name === 'console' && (!env.isProd || env.DEMO_MODE) ? { devCode: code } : {}) };
}

// Returns the user id when the code is right; throws otherwise.
export async function verifyLoginOtp(phone, code) {
  const otp = await Otp.findOne({ phone, purpose: 'login' });
  const invalid = new ApiError(401, 'OTP_INVALID', 'Invalid or expired code');
  if (!otp || otp.expiresAt < new Date()) throw invalid;
  if (otp.attempts >= MAX_ATTEMPTS) throw new ApiError(429, 'OTP_LOCKED', 'Too many wrong attempts. Request a new code.');

  const ok = crypto.timingSafeEqual(Buffer.from(otp.codeHash), Buffer.from(hashCode(phone, code)));
  if (!ok) {
    otp.attempts += 1;
    await otp.save();
    throw invalid;
  }
  // Single use: expire immediately but keep the doc for the send-rate window.
  otp.expiresAt = new Date();
  otp.attempts = MAX_ATTEMPTS;
  await otp.save();
  const user = await User.findOne({ phone });
  if (!user) throw invalid;
  return user;
}
