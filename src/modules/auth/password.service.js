import crypto from 'node:crypto';
import env from '../../config/env.js';
import ApiError from '../../common/errors/ApiError.js';
import { sha256 } from '../../common/utils/codes.js';
import { email } from '../../integrations/email.js';
import User from '../users/user.model.js';
import PasswordReset from './passwordReset.model.js';
import RefreshToken from './refreshToken.model.js';

const RESET_TTL_MS = 30 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_PER_HOUR = 3;
const GENERIC = 'If an account exists for this email, a reset link has been sent.';

const appLink = (path) => `${env.APP_URL.replace(/\/$/, '')}${path}`;

async function issueToken(userId, purpose) {
  const token = crypto.randomBytes(32).toString('base64url');
  await PasswordReset.create({
    user: userId,
    tokenHash: sha256(token),
    purpose,
    expiresAt: new Date(Date.now() + (purpose === 'invite' ? INVITE_TTL_MS : RESET_TTL_MS)),
  });
  return token;
}

// Always answers the same way so the endpoint can't be used to discover who has an account.
export async function requestReset(rawEmail) {
  const user = await User.findOne({ email: rawEmail.toLowerCase(), status: 'active' }).select('name email').lean();
  if (!user) return { message: GENERIC };
  const recent = await PasswordReset.countDocuments({ user: user._id, createdAt: { $gte: new Date(Date.now() - 3600 * 1000) } });
  if (recent >= MAX_PER_HOUR) return { message: GENERIC };

  const token = await issueToken(user._id, 'reset');
  const link = appLink(`/reset-password?token=${token}`);
  await email.send({
    to: user.email,
    subject: 'Reset your ColonyHub password',
    text: `Hi ${user.name},\n\nUse this link within 30 minutes to choose a new password:\n${link}\n\nIf you didn't ask for this, ignore this email — your password stays the same.\n`,
  });
  // Dev convenience: with the console email provider there is no inbox, so return the link.
  return { message: GENERIC, ...(email.name === 'console' && (!env.isProd || env.DEMO_MODE) ? { devLink: link } : {}) };
}

// Sends a "set your password" email to an account created by an admin or an import.
export async function sendInvite(userId, societyName) {
  const user = await User.findById(userId).select('name email').lean();
  if (!user?.email) return null;
  const token = await issueToken(user._id, 'invite');
  const link = appLink(`/reset-password?token=${token}&invite=1`);
  await email.send({
    to: user.email,
    subject: `You're invited to ${societyName} on ColonyHub`,
    text: `Hi ${user.name},\n\n${societyName} has added you to ColonyHub. Set your password here (valid for 7 days):\n${link}\n\nYou can also log in with an SMS code if your phone number is registered.\n`,
  });
  return email.name === 'console' && (!env.isProd || env.DEMO_MODE) ? link : null;
}

// "Set your password" email for a new platform team member. Same invite token as sendInvite.
export async function sendPlatformInvite(userId, roleName) {
  const user = await User.findById(userId).select('name email').lean();
  if (!user?.email) return null;
  const token = await issueToken(user._id, 'invite');
  const link = appLink(`/reset-password?token=${token}&invite=1`);
  await email.send({
    to: user.email,
    subject: 'You have been added to the ColonyHub platform team',
    text: `Hi ${user.name},\n\nYou have been added to the ColonyHub platform team${roleName ? ` as ${roleName}` : ''}. Set your password here (valid for 7 days):\n${link}\n`,
  });
  return email.name === 'console' && (!env.isProd || env.DEMO_MODE) ? link : null;
}

export async function checkToken(token) {
  const doc = await PasswordReset.findOne({ tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: new Date() } }).lean();
  if (!doc) throw new ApiError(400, 'RESET_INVALID', 'This link is invalid or has expired. Request a new one.');
  const user = await User.findById(doc.user).select('name email').lean();
  return { purpose: doc.purpose, name: user?.name, email: user?.email };
}

export async function resetPassword(token, password) {
  // Atomic claim so a token can only be used once even with concurrent requests.
  const doc = await PasswordReset.findOneAndUpdate(
    { tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: new Date() } },
    { usedAt: new Date() },
    { returnDocument: 'after' },
  );
  if (!doc) throw new ApiError(400, 'RESET_INVALID', 'This link is invalid or has expired. Request a new one.');
  await User.updateOne({ _id: doc.user }, { passwordHash: await User.hashPassword(password) });
  // Invalidate every other outstanding link and sign out all devices.
  await PasswordReset.updateMany({ user: doc.user, usedAt: null }, { usedAt: new Date() });
  // expiresAt too, so the refresh reuse grace window can't revive them
  const now = new Date();
  await RefreshToken.updateMany({ user: doc.user, expiresAt: { $gt: now } }, { revokedAt: now, expiresAt: now });
  return { reset: true };
}
