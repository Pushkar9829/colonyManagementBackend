import crypto from 'node:crypto';
import mongoose from 'mongoose';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import User from '../users/user.model.js';
import Membership from '../users/membership.model.js';
import Society from '../society/society.model.js';
import RefreshToken from '../auth/refreshToken.model.js';
import PasswordReset from '../auth/passwordReset.model.js';
import MfaChallenge from '../auth/mfaChallenge.model.js';
import Otp from '../auth/otp.model.js';
import PushSubscription from '../notifications/pushSubscription.model.js';
import Notification from '../notifications/notification.model.js';
import DirectoryProfile from '../directory/directoryProfile.model.js';
import Household from '../household/household.model.js';
import KycDocument from '../kyc/kycDocument.model.js';
import Listing from '../marketplace/listing.model.js';
import Vehicle from '../vehicles/vehicle.model.js';
import DeletionRequest from './deletionRequest.model.js';
import Upload from '../uploads/upload.model.js';
import { storage } from '../../integrations/storage.js';
import logger from '../../common/utils/logger.js';
import * as units from '../units/units.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import { sendEmailQuietly } from '../../integrations/email.js';

export const ANONYMOUS_NAME = 'Former resident';
const OPEN = ['active', 'pending'];

const sameId = (a, b) => String(a) === String(b);
const societiesOf = async (userId) =>
  (await Membership.distinct('society', { user: userId, status: { $in: OPEN }, support: { $ne: true } })).map(String);

// Every audit row belongs to a society; a platform-only request is recorded on the request's own history instead.
const auditAll = (societyIds, actor, ip, action, id, meta, entity = 'DeletionRequest') =>
  societyIds.forEach((s) => audit.record({ societyId: s, userId: actor, ip }, action, entity, id, meta));

// Societies (among `societyIds`, or all) where this person is the only active admin.
async function soleAdminSocieties(userId, societyIds) {
  const filter = { user: userId, role: ROLES.ADMIN, status: 'active', support: { $ne: true } };
  if (societyIds) filter.society = { $in: societyIds };
  const mine = await Membership.find(filter).select('society').lean();
  const out = [];
  for (const m of mine) {
    // eslint-disable-next-line no-await-in-loop
    const others = await Membership.find({ society: m.society, role: ROLES.ADMIN, status: 'active', support: { $ne: true }, user: { $ne: userId } }).select('user').lean();
    // eslint-disable-next-line no-await-in-loop
    const activeOthers = others.length ? await User.countDocuments({ _id: { $in: others.map((o) => o.user) }, status: 'active' }) : 0;
    if (!activeOthers) out.push(m.society);
  }
  if (!out.length) return [];
  return Society.find({ _id: { $in: out } }).select('name').lean();
}

async function assertNotSoleAdmin(userId, societyIds) {
  const sole = await soleAdminSocieties(userId, societyIds);
  if (sole.length) {
    throw ApiError.conflict(`${sole.map((s) => s.name).join(', ')} would be left without an admin. Make someone else an admin first, then approve this request.`);
  }
}

const present = (r) => ({
  _id: r._id,
  user: r.user,
  userName: r.userName,
  reason: r.reason,
  status: r.status,
  societies: r.societies?.length || 0,
  approvals: r.approvals?.length || 0,
  decidedAt: r.decidedAt,
  decisionNote: r.decisionNote,
  completedAt: r.completedAt,
  createdAt: r.createdAt,
});

// ---------- the person ----------
export async function myRequest(ctx) {
  const r = await DeletionRequest.findOne({ user: ctx.userId }).sort({ createdAt: -1 }).lean();
  return r ? present(r) : null;
}

export async function requestDeletion(ctx, { reason }) {
  if (await DeletionRequest.exists({ user: ctx.userId, status: 'pending' })) throw ApiError.conflict('You already have a deletion request waiting for a decision');
  const societies = await societiesOf(ctx.userId);
  const user = await User.findById(ctx.userId).select('name').lean();
  let r;
  try {
    r = await DeletionRequest.create({ user: ctx.userId, userName: user.name, societies, reason, history: [{ action: 'requested', by: ctx.userId, note: reason }] });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('You already have a deletion request waiting for a decision');
    throw err;
  }
  auditAll(societies, ctx.userId, ctx.ip, 'privacy.deletion_requested', r._id);
  await Promise.all(
    societies.map((s) =>
      notifyRoles(s, [ROLES.ADMIN], { type: 'account', title: 'Account deletion request', body: `${user.name} asked for their account and personal data to be deleted.`, link: '/privacy/requests' }),
    ),
  );
  const soleAdminOf = (await soleAdminSocieties(ctx.userId)).map((s) => s.name);
  return { ...present(r.toObject()), soleAdminOf };
}

export async function cancelRequest(ctx) {
  const r = await DeletionRequest.findOneAndUpdate(
    { user: ctx.userId, status: 'pending' },
    { $set: { status: 'cancelled', decidedAt: new Date() }, $push: { history: { action: 'cancelled', by: ctx.userId } } },
    { returnDocument: 'after' },
  ).lean();
  if (!r) throw ApiError.notFound('No pending deletion request');
  auditAll(r.societies, ctx.userId, ctx.ip, 'privacy.deletion_cancelled', r._id);
  return present(r);
}

// ---------- admins (society) and the platform owner (people with no society) ----------
const scope = (ctx) => (ctx.societyId ? { societies: ctx.societyId } : { societies: { $size: 0 } });

export async function list(ctx, { status }, { page, limit, skip }) {
  const filter = { ...scope(ctx), ...(status ? { status } : {}) };
  const [rows, total] = await Promise.all([DeletionRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), DeletionRequest.countDocuments(filter)]);
  // Who the person is in this society (role / flat), so the admin knows what approving means.
  const memberships = ctx.societyId
    ? await Membership.find({ society: ctx.societyId, user: { $in: rows.map((r) => r.user) }, support: { $ne: true } }).populate('unit', 'label').select('user role unit status').lean()
    : [];
  const items = rows.map((r) => ({
    ...present(r),
    approvedHere: ctx.societyId ? r.approvals.some((a) => sameId(a.society, ctx.societyId)) : false,
    roles: memberships.filter((m) => sameId(m.user, r.user)).map((m) => ({ role: m.role, unit: m.unit?.label, status: m.status })),
  }));
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

async function getForDecision(ctx, id) {
  const r = await DeletionRequest.findOne({ _id: id, ...scope(ctx) });
  if (!r) throw ApiError.notFound('Request not found');
  if (r.status !== 'pending') throw ApiError.badRequest(`This request is already ${r.status}`);
  if (sameId(r.user, ctx.userId)) throw ApiError.forbidden('Another admin must decide on your own request');
  return r;
}

export async function approve(ctx, id, note) {
  const r = await getForDecision(ctx, id);
  if (ctx.societyId) {
    if (r.approvals.some((a) => sameId(a.society, ctx.societyId))) throw ApiError.conflict('Your society has already approved this request');
    await assertNotSoleAdmin(r.user, [ctx.societyId]);
    r.approvals.push({ society: ctx.societyId, by: ctx.userId });
  }
  r.history.push({ action: 'approved', by: ctx.userId, society: ctx.societyId || undefined, note });
  const waitingOn = r.societies.filter((s) => !r.approvals.some((a) => sameId(a.society, s)));
  if (ctx.societyId) audit.record(ctx, 'privacy.deletion_approved', 'DeletionRequest', r._id, { note, waitingOn: waitingOn.length });

  if (!waitingOn.length) {
    // Re-check every society right before erasing: memberships may have changed since the request was made.
    await assertNotSoleAdmin(r.user);
    await anonymise(r.user, ctx);
    Object.assign(r, { status: 'approved', decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: note, completedAt: new Date(), userName: ANONYMOUS_NAME });
    r.history.push({ action: 'anonymised', by: ctx.userId });
  }
  await r.save();
  return present(r.toObject());
}

export async function reject(ctx, id, note) {
  const r = await getForDecision(ctx, id);
  Object.assign(r, { status: 'rejected', decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: note });
  r.history.push({ action: 'rejected', by: ctx.userId, society: ctx.societyId || undefined, note });
  await r.save();
  auditAll(r.societies, ctx.userId, ctx.ip, 'privacy.deletion_rejected', r._id, { note, by: ctx.societyId ? 'society' : 'platform' });
  const user = await User.findById(r.user).select('email name').lean();
  if (ctx.societyId) {
    await notifyUsers(ctx.societyId, [r.user], { type: 'account', title: 'Deletion request declined', body: note, link: '/profile' });
  }
  sendEmailQuietly({
    to: user?.email,
    subject: 'Your ColonyHub account deletion request',
    text: `Hi ${user?.name},\n\nYour request to delete your ColonyHub account was declined:\n${note}\n\nYou can reply to your society office or raise a new request from your profile.\n`,
  });
  return present(r.toObject());
}

// Erases what identifies the person and ends their access, but keeps the society's financial and statutory records.
//
// Why records are kept: the DPDP Act 2023 requires erasure "unless retention is necessary for compliance with any
// law" (s.8(7), s.12(3)). Societies must keep accounts, bills, receipts and payment records for years under their
// state co-operative societies act and Indian tax law (Income-tax Act s.44AA / rule 6F, CGST Act s.36), and must
// maintain statutory registers (members, share certificates, nominations) and an audit trail. So bills, payments,
// receipts, registers, KYC ownership/ID records and the audit log stay linked to the flat; the user id they point to
// now resolves to "Former resident" with no contact details, login, sessions or memberships.
// Deletes the stored files (local disk or Cloudinary) behind the KYC photos and "other" documents erased
// below, not just their database records. Retained ID / ownership proofs keep their files.
async function eraseKycFiles(userId) {
  const docs = await KycDocument.find({ user: userId, category: { $in: ['photo', 'other'] } }).select('files').lean();
  const urls = docs.flatMap((d) => (d.files || []).map((f) => f.url)).filter(Boolean);
  if (!urls.length) return;
  const uploads = await Upload.find({ url: { $in: urls } }).select('key').lean();
  await Promise.all(uploads.map((u) => storage.remove(u.key).catch((err) => logger.warn({ err, key: u.key }, 'could not delete an erased file'))));
  await Upload.deleteMany({ _id: { $in: uploads.map((u) => u._id) } });
}

export async function anonymise(userId, ctx) {
  const user = await User.findById(userId).select('name email phone platformRole platformStatus').lean();
  if (!user) throw ApiError.notFound('User not found');
  if (user.platformRole === 'super_admin') {
    const otherOwners = await User.countDocuments({ _id: { $ne: userId }, platformRole: 'super_admin', status: 'active', platformStatus: { $ne: 'inactive' } });
    if (!otherOwners) throw ApiError.conflict('This person is the only platform Owner. Make someone else an Owner before deleting this account.');
  }
  const memberships = await Membership.find({ user: userId, status: { $in: OPEN } }).select('society unit').lean();
  const societies = [...new Set((await Membership.distinct('society', { user: userId })).map(String))];
  const oid = new mongoose.Types.ObjectId(String(userId));

  await User.updateOne(
    { _id: userId },
    {
      $set: {
        name: ANONYMOUS_NAME,
        status: 'inactive',
        // An unguessable hash nobody knows: the field is required, and this can never match a login attempt.
        passwordHash: await User.hashPassword(crypto.randomBytes(32).toString('hex')),
        notificationPrefs: { sms: false, whatsapp: false, email: false },
        anonymisedAt: new Date(),
      },
      $unset: { email: 1, phone: 1, mfa: 1, platformRole: 1, platformRoleId: 1, platformStatus: 1, platformAddedAt: 1, lastMembership: 1, lastLoginAt: 1 },
    },
  );
  await Membership.updateMany({ user: userId, status: { $in: OPEN } }, { $set: { status: 'inactive' } });
  await eraseKycFiles(userId);
  await Promise.all([
    ...memberships.filter((m) => m.unit).map((m) => units.refreshOccupancy(m.society, m.unit)),
    RefreshToken.deleteMany({ user: userId }), // every session ends now; device/IP history goes with them
    PasswordReset.deleteMany({ user: userId }),
    MfaChallenge.deleteMany({ user: userId }),
    user.phone ? Otp.deleteMany({ phone: user.phone }) : null,
    PushSubscription.deleteMany({ user: userId }),
    Notification.deleteMany({ user: userId }),
    DirectoryProfile.deleteMany({ user: userId }),
    Household.updateMany({ 'residentMedical.user': oid }, { $pull: { residentMedical: { user: oid } } }),
    // Photos and miscellaneous uploads are not statutory; ID / ownership proofs are retained (see above).
    KycDocument.deleteMany({ user: userId, category: { $in: ['photo', 'other'] } }),
    Listing.updateMany({ seller: userId, status: 'active' }, { $set: { status: 'removed', removedReason: 'Seller account deleted' } }),
    Vehicle.updateMany({ owner: userId }, { $unset: { owner: 1 } }),
  ]);
  auditAll(societies, ctx.userId, ctx.ip, 'privacy.user_anonymised', userId, { memberships: memberships.length }, 'User');
  sendEmailQuietly({
    to: user.email,
    subject: 'Your ColonyHub account has been deleted',
    text: `Hi ${user.name},\n\nAs you asked, your ColonyHub account has been deleted and your personal details removed. Your society keeps the bills, receipts and registers it must retain by law, without your contact details.\n`,
  });
}
