import ApiError from '../../common/errors/ApiError.js';
import User from '../users/user.model.js';
import Membership from '../users/membership.model.js';
import RefreshToken from '../auth/refreshToken.model.js';
import Complaint from '../complaints/complaint.model.js';
import Visitor from '../visitors/visitor.model.js';
import GuestPass from '../visitors/guestPass.model.js';
import Booking from '../amenities/booking.model.js';
import Bill from '../billing/bill.model.js';
import Payment from '../payments/payment.model.js';
import Notice from '../notices/notice.model.js';
import Poll from '../polls/poll.model.js';
import PollVote from '../polls/pollVote.model.js';
import ChatMessage from '../chat/chatMessage.model.js';
import ForumTopic from '../forum/forumTopic.model.js';
import ForumReply from '../forum/forumReply.model.js';
import Listing from '../marketplace/listing.model.js';
import Vehicle from '../vehicles/vehicle.model.js';
import SosAlert from '../sos/sos.model.js';
import DirectoryProfile from '../directory/directoryProfile.model.js';
import EventRsvp from '../events/eventRsvp.model.js';
import ServiceRequest from '../requests/serviceRequest.model.js';
import LostFoundItem from '../lostFound/lostFoundItem.model.js';
import KycDocument from '../kyc/kycDocument.model.js';
import Household from '../household/household.model.js';
import Notification from '../notifications/notification.model.js';
import PushSubscription from '../notifications/pushSubscription.model.js';
import Lease from '../tenancy/lease.model.js';
import DataExport from './dataExport.model.js';
import * as audit from '../audit/audit.service.js';

const EXPORT_COOLDOWN_MS = 10 * 60 * 1000;
const CAP = 5000; // per collection; keeps one export bounded for very active accounts

const str = (v) => (v == null ? v : String(v));

// Everything the signed-in person has given or generated, across every society they belong to (DPDP Act 2023, s.11
// right to access). Other people's personal data is left out: no phone numbers of visitors, no staff ids, no
// other people's votes, no internal staff notes. Secrets (password hash, tokens, MFA) are never selected.
export async function buildExport(ctx) {
  const since = new Date(Date.now() - EXPORT_COOLDOWN_MS);
  const recent = await DataExport.findOne({ user: ctx.userId, createdAt: { $gt: since } }).sort({ createdAt: -1 }).lean();
  if (recent) {
    const wait = Math.ceil((recent.createdAt.getTime() + EXPORT_COOLDOWN_MS - Date.now()) / 60000);
    throw new ApiError(429, 'EXPORT_COOLDOWN', `You downloaded your data a moment ago. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`);
  }
  await DataExport.create({ user: ctx.userId });

  const user = await User.findById(ctx.userId).select('name email phone status platformRole notificationPrefs lastLoginAt createdAt mfa.enabled mfa.enabledAt').lean();
  const memberships = await Membership.find({ user: ctx.userId, support: { $ne: true } })
    .populate('society', 'name city')
    .populate('unit', 'label')
    .sort({ createdAt: 1 })
    .lean();
  const societies = [...new Set(memberships.map((m) => String(m.society?._id || m.society)))];
  const inSociety = { society: { $in: societies } };
  const me = ctx.userId;
  // Units the person lives in (or lived in) — their household's bills and payments are theirs to see.
  const unitIds = memberships.filter((m) => m.unit).map((m) => m.unit._id);

  const q = (Model, filter, select, sort = { createdAt: -1 }) => Model.find({ ...inSociety, ...filter }).select(select).sort(sort).limit(CAP).lean();

  const [
    complaints, visitorsResponded, guestPasses, bookings, bills, payments, noticesSeen, votes, chat, topics, replies,
    listings, vehicles, sos, directory, rsvps, requests, lostFound, kyc, households, notifications, pushSubs, leases, sessions,
  ] = await Promise.all([
    q(Complaint, { raisedBy: me }, 'ticketNumber category priority area title description attachments status resolvedAt closedAt comments rating feedback createdAt'),
    q(Visitor, { respondedBy: me }, 'name purpose company vehicleNumber guests status respondedAt checkInAt checkOutAt createdAt'),
    q(GuestPass, { createdBy: me }, 'guestName purpose kind validFrom validTo maxUses usedCount status createdAt'),
    q(Booking, { user: me }, 'amenity date startTime endTime guests notes fee deposit status paymentStatus cancelledAt cancelReason createdAt'),
    unitIds.length ? q(Bill, { unit: { $in: unitIds } }, 'unit period kind billNumber lines amount lateFee waived total paid dueDate status createdAt', { period: -1 }) : [],
    unitIds.length ? q(Payment, { unit: { $in: unitIds } }, 'unit bill purpose amount method reference status receiptNumber paidAt paidBy createdAt', { paidAt: -1 }) : [],
    q(Notice, { $or: [{ 'acks.user': me }, { readBy: me }] }, 'title category createdAt acks readBy'),
    q(PollVote, { user: me }, 'poll optionIndex createdAt'),
    q(ChatMessage, { sender: me }, 'conversation text attachments context createdAt'),
    q(ForumTopic, { author: me }, 'category title body attachments status createdAt editedAt'),
    q(ForumReply, { author: me }, 'topic body status createdAt editedAt'),
    q(Listing, { seller: me }, 'type title description category condition price priceUnit photos status createdAt'),
    q(Vehicle, { owner: me }, 'number type make color parkingSlot fuel createdAt'),
    q(SosAlert, { raisedBy: me }, 'type message status createdAt resolvedAt'),
    q(DirectoryProfile, { user: me }, 'listed showPhone showEmail showProfession profession skills about updatedAt'),
    q(EventRsvp, { user: me }, 'event response guests headcount state paymentStatus createdAt'),
    q(ServiceRequest, { raisedBy: me }, 'number kind nocType unitLabel purpose description status decisionNote createdAt'),
    q(LostFoundItem, { postedBy: me }, 'kind title description category location date status createdAt'),
    q(KycDocument, { user: me }, 'type category last4 nameOnDocument status rejectionReason reviewedAt createdAt'),
    q(Household, { 'residentMedical.user': me }, 'unit residentMedical'),
    q(Notification, { user: me }, 'type title body link readAt createdAt'),
    PushSubscription.find({ user: me }).select('userAgent createdAt').lean(),
    q(Lease, { $or: [{ tenantUser: me }, { ownerUser: me }] }, 'unit startDate endDate rent securityDeposit status endedAt createdAt'),
    RefreshToken.find({ user: me, expiresAt: { $gt: new Date() }, revokedAt: null }).select('userAgent ip createdAt').sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  // Only the person's own vote: which option they picked, never the tally or anyone else's choice.
  const polls = await Poll.find({ _id: { $in: votes.map((v) => v.poll) } }).select('question options.text').lean();
  const pollById = new Map(polls.map((p) => [String(p._id), p]));
  const unitLabel = new Map(memberships.filter((m) => m.unit).map((m) => [String(m.unit._id), m.unit.label]));
  const meStr = String(me);

  const data = {
    format: 'ColonyHub personal data export',
    version: 1,
    generatedAt: new Date(),
    notes: [
      'This file contains the personal data ColonyHub holds about you, across every society you belong to.',
      'Bills and payments are for the flats you are linked to. Other people are shown by name only where you could already see them.',
    ],
    profile: {
      name: user.name,
      email: user.email,
      phone: user.phone,
      status: user.status,
      platformRole: user.platformRole,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      twoStepVerification: { enabled: Boolean(user.mfa?.enabled), enabledAt: user.mfa?.enabledAt },
    },
    consents: {
      notificationChannels: user.notificationPrefs,
      directory: directory.map(({ _id, ...d }) => d),
      pushDevices: pushSubs.map((p) => ({ userAgent: p.userAgent, since: p.createdAt })),
    },
    memberships: memberships.map((m) => ({
      society: m.society?.name,
      city: m.society?.city,
      role: m.role,
      unit: m.unit?.label,
      residentType: m.residentType,
      designation: m.designation,
      status: m.status,
      since: m.createdAt,
    })),
    signedInDevices: sessions.map((s) => ({ userAgent: s.userAgent, ip: s.ip, signedInAt: s.createdAt })),
    complaints: complaints.map(({ comments = [], _id, ...c }) => ({
      ...c,
      // Staff-internal notes are not part of the resident's record; own notes always are.
      comments: comments.filter((x) => !x.internal || String(x.by) === meStr).map((x) => ({ byYou: String(x.by) === meStr, text: x.text, at: x.createdAt })),
    })),
    visitorsYouResponded: visitorsResponded.map(({ _id, ...v }) => v),
    guestPassesYouCreated: guestPasses.map(({ _id, ...g }) => g),
    amenityBookings: bookings.map(({ _id, ...b }) => ({ ...b, amenity: str(b.amenity) })),
    bills: bills.map(({ _id, unit, ...b }) => ({ ...b, unit: unitLabel.get(String(unit)) })),
    payments: payments.map(({ _id, unit, bill, paidBy, ...p }) => ({ ...p, unit: unitLabel.get(String(unit)), bill: str(bill), paidByYou: String(paidBy) === meStr })),
    noticesAcknowledged: noticesSeen.map((n) => ({
      title: n.title,
      category: n.category,
      postedAt: n.createdAt,
      read: (n.readBy || []).some((u) => String(u) === meStr),
      acknowledgedAt: (n.acks || []).find((a) => String(a.user) === meStr)?.at || null,
    })),
    pollVotes: votes.map((v) => {
      const p = pollById.get(String(v.poll));
      return { question: p?.question, yourChoice: p?.options?.[v.optionIndex]?.text, votedAt: v.createdAt };
    }),
    chatMessagesSent: chat.map(({ _id, conversation, ...m }) => ({ ...m, conversation: str(conversation) })),
    forumTopics: topics.map(({ _id, ...t }) => ({ id: str(_id), ...t })),
    forumReplies: replies.map(({ _id, topic, ...r }) => ({ ...r, topic: str(topic) })),
    marketplaceListings: listings.map(({ _id, ...l }) => l),
    vehicles: vehicles.map(({ _id, ...v }) => v),
    sosAlerts: sos.map(({ _id, ...s }) => s),
    eventRsvps: rsvps.map(({ _id, event, ...r }) => ({ ...r, event: str(event) })),
    serviceRequests: requests.map(({ _id, ...r }) => r),
    lostAndFound: lostFound.map(({ _id, ...l }) => l),
    kycDocuments: kyc.map(({ _id, ...k }) => k),
    medicalInformation: households.flatMap((h) => h.residentMedical.filter((r) => String(r.user) === meStr).map(({ user: _u, ...r }) => ({ unit: unitLabel.get(String(h.unit)), ...r }))),
    leases: leases.map(({ _id, unit, ...l }) => ({ ...l, unit: unitLabel.get(String(unit)) })),
    notifications: notifications.map(({ _id, ...n }) => n),
  };
  for (const s of societies) audit.record({ societyId: s, userId: ctx.userId, ip: ctx.ip }, 'privacy.data_exported', 'User', ctx.userId);
  return { filename: `colonyhub-my-data-${new Date().toISOString().slice(0, 10)}.json`, data };
}
