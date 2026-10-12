import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import ApiError from '../../common/errors/ApiError.js';
import { randomCode } from '../../common/utils/codes.js';
import { derivedKey, keyedHash, open, seal } from '../../common/utils/secretBox.js';
import { generateSecret, otpauthUri, verifyTotp } from '../../common/utils/totp.js';
import User from '../users/user.model.js';
import MfaChallenge from './mfaChallenge.model.js';
import * as audit from '../audit/audit.service.js';

const ISSUER = 'ColonyHub';
const SEAL_PURPOSE = 'mfa-totp-secret';
const BACKUP_PURPOSE = 'mfa-backup-code';
const CHALLENGE_TTL_S = 5 * 60;
const CHALLENGE_AUDIENCE = 'colonyhub:mfa-login';
const MAX_ATTEMPTS = 5;
const BACKUP_CODES = 10;
const PENDING_TTL_MS = 15 * 60 * 1000;

// Separate signing key from access tokens, so an mfaToken can never pass `authenticate` (and vice versa).
const challengeKey = () => derivedKey('jwt:mfa-challenge');

const codeInvalid = () => new ApiError(400, 'MFA_CODE_INVALID', 'That code is not right. Check your authenticator app and try again.');
const codeReused = () => new ApiError(400, 'MFA_CODE_REUSED', 'This code was already used. Wait for the next one in your app.');
const locked = () => new ApiError(429, 'MFA_LOCKED', 'Too many wrong codes. Please log in again.');

// A platform session has no society, and the audit log is per society.
const auditMaybe = (ctx, action) => ctx.societyId && audit.record(ctx, action, 'User', ctx.userId);

const normaliseBackup = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashBackup = (c) => keyedHash(normaliseBackup(c), BACKUP_PURPOSE);
function newBackupCodes() {
  const plain = Array.from({ length: BACKUP_CODES }, () => {
    const c = randomCode(10); // 32-letter alphabet, so ~50 bits each
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
  return { plain, hashed: plain.map(hashBackup) };
}

const loadWithMfa = (userId) => User.findById(userId).select('+mfa name email phone').lean();

export async function isEnabled(userId) {
  const u = await User.findById(userId).select('mfa.enabled').lean();
  return Boolean(u?.mfa?.enabled);
}

export async function status(ctx) {
  const mfa = (await loadWithMfa(ctx.userId))?.mfa || {};
  return { enabled: Boolean(mfa.enabled), enabledAt: mfa.enabledAt || null, backupCodesLeft: mfa.enabled ? mfa.backupCodes?.length || 0 : 0 };
}

// Step 1 of enabling: a fresh secret kept as "pending" until the user proves their app has it.
export async function setup(ctx) {
  const u = await loadWithMfa(ctx.userId);
  if (u.mfa?.enabled) throw ApiError.conflict('Two-step verification is already on. Turn it off first to move to a new app.');
  const secret = generateSecret();
  await User.updateOne({ _id: ctx.userId }, { $set: { 'mfa.pendingSecret': seal(secret, SEAL_PURPOSE), 'mfa.pendingCreatedAt': new Date() } });
  const account = u.email || u.phone || u.name;
  return { secret, otpauthUri: otpauthUri({ secret, account, issuer: ISSUER }), issuer: ISSUER, account };
}

export async function enable(ctx, code) {
  const u = await loadWithMfa(ctx.userId);
  if (u.mfa?.enabled) throw ApiError.conflict('Two-step verification is already on');
  const pending = u.mfa?.pendingSecret;
  if (!pending || Date.now() - new Date(u.mfa.pendingCreatedAt).getTime() > PENDING_TTL_MS) {
    throw new ApiError(400, 'MFA_SETUP_EXPIRED', 'Setup expired. Start again to get a new QR code.');
  }
  const step = verifyTotp(open(pending, SEAL_PURPOSE), code);
  if (step === null) throw codeInvalid();
  const codes = newBackupCodes();
  const now = new Date();
  // Conditional on still-pending, so two concurrent enables can't hand out two sets of backup codes.
  const res = await User.updateOne(
    { _id: ctx.userId, 'mfa.enabled': { $ne: true }, 'mfa.pendingSecret': pending },
    { $set: { mfa: { enabled: true, secret: pending, backupCodes: codes.hashed, lastUsedStep: step, enabledAt: now } } },
  );
  if (!res.modifiedCount) throw ApiError.conflict('Two-step verification is already on');
  auditMaybe(ctx, 'user.mfa_enabled');
  return { enabled: true, enabledAt: now, backupCodes: codes.plain };
}

// Checks a TOTP code (±1 step, no replay) or consumes a backup code. Resolves 'totp' | 'backup'; throws otherwise.
async function checkSecondFactor(user, { code, backupCode }) {
  const mfa = user.mfa;
  if (!mfa?.enabled || !mfa.secret) throw codeInvalid();
  if (backupCode) {
    const hash = hashBackup(backupCode);
    const res = await User.updateOne({ _id: user._id, 'mfa.enabled': true, 'mfa.backupCodes': hash }, { $pull: { 'mfa.backupCodes': hash } });
    if (!res.modifiedCount) throw codeInvalid();
    return 'backup';
  }
  const step = verifyTotp(open(mfa.secret, SEAL_PURPOSE), code);
  if (step === null) throw codeInvalid();
  // Atomic "newer than the last accepted step": the same code (or an older one) can't be used twice.
  const res = await User.updateOne(
    { _id: user._id, 'mfa.enabled': true, $or: [{ 'mfa.lastUsedStep': null }, { 'mfa.lastUsedStep': { $lt: step } }] },
    { $set: { 'mfa.lastUsedStep': step } },
  );
  if (!res.modifiedCount) throw codeReused();
  return 'totp';
}

// Needs the password and a current code (or a backup code, for someone whose phone is gone).
export async function disable(ctx, { password, code }) {
  const u = await User.findById(ctx.userId).select('+passwordHash +mfa');
  if (!u.mfa?.enabled) throw ApiError.badRequest('Two-step verification is not on');
  if (!(await u.verifyPassword(password))) throw ApiError.badRequest('Password is incorrect');
  const trimmed = String(code).trim();
  await checkSecondFactor({ _id: u._id, mfa: u.mfa.toObject() }, /^\d{6}$/.test(trimmed) ? { code: trimmed } : { backupCode: trimmed });
  await User.updateOne({ _id: ctx.userId }, { $unset: { mfa: 1 } });
  auditMaybe(ctx, 'user.mfa_disabled');
  return { enabled: false };
}

export async function regenerateBackupCodes(ctx, code) {
  const u = await loadWithMfa(ctx.userId);
  if (!u.mfa?.enabled) throw ApiError.badRequest('Two-step verification is not on');
  await checkSecondFactor(u, { code });
  const codes = newBackupCodes();
  await User.updateOne({ _id: ctx.userId }, { $set: { 'mfa.backupCodes': codes.hashed } });
  auditMaybe(ctx, 'user.mfa_backup_codes_regenerated');
  return { backupCodes: codes.plain };
}

// ---------- login second step ----------
export async function issueChallenge(userId, via) {
  const jti = crypto.randomUUID();
  await MfaChallenge.create({ jti, user: userId, via, expiresAt: new Date(Date.now() + CHALLENGE_TTL_S * 1000) });
  const mfaToken = jwt.sign({ sub: String(userId), purpose: 'mfa_login', jti }, challengeKey(), { expiresIn: CHALLENGE_TTL_S, audience: CHALLENGE_AUDIENCE });
  return { mfaRequired: true, mfaToken, expiresIn: CHALLENGE_TTL_S };
}

// Resolves the user id once the code is right. Five wrong codes lock this mfaToken (log in again for a new one).
export async function verifyChallenge(mfaToken, { code, backupCode }) {
  const expired = () => new ApiError(401, 'MFA_TOKEN_INVALID', 'Your sign-in has expired. Please log in again.');
  let payload;
  try {
    payload = jwt.verify(mfaToken, challengeKey(), { audience: CHALLENGE_AUDIENCE });
  } catch {
    throw expired();
  }
  if (payload.purpose !== 'mfa_login' || !payload.jti) throw expired();
  const challenge = await MfaChallenge.findOne({ jti: payload.jti, user: payload.sub }).lean();
  if (!challenge || challenge.usedAt || challenge.expiresAt <= new Date()) throw expired();
  if (challenge.attempts >= MAX_ATTEMPTS) throw locked();

  const user = await User.findById(payload.sub).select('+mfa').lean();
  if (!user) throw expired();
  try {
    await checkSecondFactor(user, { code, backupCode });
  } catch (err) {
    const after = await MfaChallenge.findOneAndUpdate({ _id: challenge._id }, { $inc: { attempts: 1 } }, { returnDocument: 'after' }).lean();
    if (after.attempts >= MAX_ATTEMPTS) throw locked();
    throw new ApiError(401, err.code || 'MFA_CODE_INVALID', err.message);
  }
  const claimed = await MfaChallenge.findOneAndUpdate({ _id: challenge._id, usedAt: null }, { usedAt: new Date() });
  if (!claimed) throw expired();
  return user._id;
}
