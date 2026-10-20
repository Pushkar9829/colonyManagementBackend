import Notification from './notification.model.js';
import PushSubscription from './pushSubscription.model.js';
import User from '../users/user.model.js';
import Membership from '../users/membership.model.js';
import logger from '../../common/utils/logger.js';
import { paginate } from '../../common/utils/pagination.js';
import { emitToUser } from '../../realtime/socket.js';
import { pushEnabled, sendPush } from '../../integrations/webPush.js';
import { sendSmsQuietly } from '../../integrations/sms.js';
import * as whatsappGate from '../whatsapp/whatsapp.service.js';
import { sendEmailQuietly } from '../../integrations/email.js';
import env from '../../config/env.js';

// Every notification is stored in-app and pushed live over the socket.
// Optional extra channels per call: 'push' (web push), 'sms', 'whatsapp' and 'email'.
// SMS/WhatsApp respect each user's preferences, except safety alerts sent with `urgent: true`.
const DEFAULT_CHANNELS = ['inapp', 'push'];

async function deliverPush(userIds, payload) {
  if (!pushEnabled) return;
  const subs = await PushSubscription.find({ user: { $in: userIds } }).lean();
  await Promise.all(
    subs.map(async (s) => {
      try {
        const r = await sendPush({ endpoint: s.endpoint, keys: s.keys }, payload);
        if (r === 'gone') await PushSubscription.deleteOne({ _id: s._id });
      } catch (err) {
        logger.warn({ err: err.message }, 'web push failed');
      }
    }),
  );
}

async function phonesFor(userIds, pref, urgent) {
  const filter = { _id: { $in: userIds }, phone: { $type: 'string' } };
  if (!urgent) filter[`notificationPrefs.${pref}`] = { $ne: false };
  return User.find(filter).select('phone').lean();
}

async function deliverSms(userIds, { title, body }, urgent) {
  const text = `${title}${body ? ` - ${body}` : ''}`.slice(0, 300);
  for (const u of await phonesFor(userIds, 'sms', urgent)) sendSmsQuietly(u.phone, text);
}

async function deliverEmail(userIds, { title, body, link, society }, urgent) {
  const filter = { _id: { $in: userIds }, email: { $type: 'string' } };
  if (!urgent) filter['notificationPrefs.email'] = { $ne: false };
  const users = await User.find(filter).select('email name').lean();
  const url = link ? `${env.APP_URL.replace(/\/$/, '')}${link}` : env.APP_URL;
  for (const u of users) {
    sendEmailQuietly({ to: u.email, society, subject: title, text: `Hi ${u.name},

${body || title}

Open ColonyHub: ${url}
` });
  }
}

// Every automatic WhatsApp message goes through the gate in modules/whatsapp: it applies the society's
// WhatsApp mode (off / click-to-chat / api) and charges one credit per message.
async function deliverWhatsApp(societyId, userIds, { title, body, type, waKind }, urgent) {
  if ((await whatsappGate.modeOf(societyId)) !== 'api') return;
  const kind = whatsappGate.kindFor(type, waKind);
  for (const u of await phonesFor(userIds, 'whatsapp', urgent)) {
    // eslint-disable-next-line no-await-in-loop
    await whatsappGate.sendWhatsApp(societyId, u.phone, title, body, { kind, urgent });
  }
}

// waKind (optional): what a WhatsApp message is about for credit usage reports — 'bill' | 'receipt' |
// 'reminder' | 'sos' | 'wishes' | 'notice' | 'other'. Defaults from `type`.
export async function notifyUsers(societyId, userIds, { type, title, body, link, channels = DEFAULT_CHANNELS, urgent = false, waKind }) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return;
  try {
    const docs = await Notification.insertMany(ids.map((user) => ({ society: societyId, user, type, title, body, link })));
    for (const d of docs) emitToUser(d.user, societyId, 'notification', d.toObject());
  } catch (err) {
    logger.error({ err, type }, 'notification write failed');
  }
  // External channels run in the background so the API response is not delayed.
  const payload = { title, body, link, type };
  if (channels.includes('push')) deliverPush(ids, payload).catch(() => {});
  if (channels.includes('sms')) deliverSms(ids, payload, urgent).catch(() => {});
  if (channels.includes('whatsapp')) deliverWhatsApp(societyId, ids, { ...payload, waKind }, urgent).catch(() => {});
  if (channels.includes('email')) deliverEmail(ids, { ...payload, society: societyId }, urgent).catch(() => {});
}

const memberIds = async (filter) => (await Membership.find({ ...filter, status: 'active' }).select('user').lean()).map((m) => m.user);

export async function notifyUnit(societyId, unitId, payload) {
  return notifyUsers(societyId, await memberIds({ society: societyId, unit: unitId, role: 'resident' }), payload);
}

export async function notifyRoles(societyId, roles, payload) {
  return notifyUsers(societyId, await memberIds({ society: societyId, role: { $in: roles } }), payload);
}

export async function listMine(ctx, { unread }, pagination) {
  // Notifications belong to the society the user is currently in.
  const filter = { user: ctx.userId, society: ctx.societyId };
  if (unread) filter.readAt = null;
  const result = await paginate(Notification, filter, pagination);
  result.meta.unread = await Notification.countDocuments({ user: ctx.userId, society: ctx.societyId, readAt: null });
  return result;
}

export const markRead = (ctx, id) => Notification.updateOne({ _id: id, user: ctx.userId }, { readAt: new Date() });
export const markAllRead = (ctx) => Notification.updateMany({ user: ctx.userId, society: ctx.societyId, readAt: null }, { readAt: new Date() });

// ---- web push subscriptions ----
export async function subscribePush(ctx, { endpoint, keys }, userAgent) {
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    { user: ctx.userId, endpoint, keys, userAgent: userAgent?.slice(0, 200) },
    { upsert: true, returnDocument: 'after' },
  );
}

export const unsubscribePush = (ctx, endpoint) => PushSubscription.deleteOne({ endpoint, user: ctx.userId });
