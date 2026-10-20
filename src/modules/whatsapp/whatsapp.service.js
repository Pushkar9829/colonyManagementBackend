import mongoose from 'mongoose';
import WhatsAppAccount, { DEFAULT_LOW_BALANCE } from './whatsappAccount.model.js';
import WhatsAppCredit, { MESSAGE_KINDS } from './whatsappCredit.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import logger from '../../common/utils/logger.js';
import { localPeriod } from '../../common/utils/dates.js';
import { paginate } from '../../common/utils/pagination.js';
import { whatsapp } from '../../integrations/whatsapp.js';

// Notification `type` -> usage kind, for callers that don't pass an explicit `waKind`.
const KIND_BY_TYPE = { sos: 'sos', bill: 'bill', notice: 'notice', celebration: 'wishes' };
export const kindFor = (type, waKind) => (MESSAGE_KINDS.includes(waKind) ? waKind : KIND_BY_TYPE[type] || 'other');

const mask = (phone) => (phone ? `${'*'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}` : undefined);
const FINANCE_VIEW = ['admin', 'accountant'];

export async function modeOf(societyId) {
  const acc = await WhatsAppAccount.findOne({ society: societyId }).select('mode').lean();
  return acc?.mode || 'off';
}

// Admin notices about credits. Loaded lazily: notifications.service imports this module for the gate.
async function tellAdmins(societyId, title, body) {
  const { notifyRoles } = await import('../notifications/notifications.service.js');
  await notifyRoles(societyId, ['admin'], { type: 'whatsapp_credits', title, body, link: '/settings', channels: ['inapp', 'push'] });
}

// Claims the "told once" flag atomically so concurrent sends notify a single time.
async function warnOnce(acc) {
  if (acc.balance <= 0 && !acc.emptyNotifiedAt) {
    const claimed = await WhatsAppAccount.findOneAndUpdate({ _id: acc._id, emptyNotifiedAt: null }, { emptyNotifiedAt: new Date(), lowNotifiedAt: acc.lowNotifiedAt || new Date() });
    if (claimed) await tellAdmins(acc.society, 'WhatsApp credits used up', 'Automatic WhatsApp messages have stopped (SOS alerts still go out). In-app and push notifications continue. Contact ColonyHub to add credits.');
    return;
  }
  if (acc.balance > 0 && acc.balance <= acc.lowBalanceThreshold && !acc.lowNotifiedAt) {
    const claimed = await WhatsAppAccount.findOneAndUpdate({ _id: acc._id, lowNotifiedAt: null }, { lowNotifiedAt: new Date() });
    if (claimed) await tellAdmins(acc.society, 'WhatsApp credits running low', `${acc.balance} WhatsApp credits left. Contact ColonyHub to top up before automatic messages stop.`);
  }
}

// THE gate for every WhatsApp message the system sends on its own. Checks the society's mode and credits,
// debits one credit, sends, and refunds the credit if the provider rejects the message.
// Returns 'sent' | 'failed' | 'off' | 'click_to_chat' | 'no_credits' | 'skipped'. Never throws.
export async function sendWhatsApp(societyId, phone, title, body, { kind = 'other', urgent = false } = {}) {
  if (!societyId || !phone) return 'skipped';
  try {
    const mode = await modeOf(societyId);
    if (mode !== 'api') return mode; // off, or click_to_chat: people send it themselves from the app
    // SOS is life-safety: it is sent even with no credits left and still counted, so the balance may go
    // negative. Platform top-ups settle the difference.
    const bypass = urgent || kind === 'sos';
    const acc = await WhatsAppAccount.findOneAndUpdate(
      bypass ? { society: societyId, mode: 'api' } : { society: societyId, mode: 'api', balance: { $gte: 1 } },
      { $inc: { balance: -1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!acc) {
      const current = await WhatsAppAccount.findOne({ society: societyId }).lean();
      if (current) await warnOnce(current);
      return 'no_credits';
    }
    const debit = await WhatsAppCredit.create({ society: societyId, entry: 'debit', amount: -1, kind, balanceAfter: acc.balance, to: mask(phone) });
    warnOnce(acc).catch((err) => logger.warn({ err: err.message }, 'whatsapp credit warning failed'));
    try {
      await whatsapp.sendAlert(phone, title, body);
      return 'sent';
    } catch (err) {
      const back = await WhatsAppAccount.findOneAndUpdate({ society: societyId }, { $inc: { balance: 1 } }, { returnDocument: 'after' }).lean();
      await WhatsAppCredit.create({ society: societyId, entry: 'refund', amount: 1, kind, ref: debit._id, balanceAfter: back?.balance, note: String(err.message || 'send failed').slice(0, 200), to: debit.to });
      logger.warn({ err: err.message, society: String(societyId) }, 'WhatsApp delivery failed; credit refunded');
      return 'failed';
    }
  } catch (err) {
    logger.error({ err, society: String(societyId) }, 'WhatsApp gate failed');
    return 'failed';
  }
}

// ---------- usage ----------
const monthStart = (period) => new Date(`${period}-01T00:00:00+05:30`);
const nextPeriod = (period) => {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const prevPeriod = (period, n) => {
  let [y, m] = period.split('-').map(Number);
  m -= n;
  while (m < 1) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
};

// Messages actually charged (debits minus refunds), per month and per kind.
export async function usage(societyId, { months = 6, now = new Date() } = {}) {
  const period = localPeriod(now);
  const from = monthStart(prevPeriod(period, months - 1));
  const rows = await WhatsAppCredit.aggregate([
    { $match: { society: new mongoose.Types.ObjectId(String(societyId)), entry: { $in: ['debit', 'refund'] }, createdAt: { $gte: from } } },
    { $group: { _id: { month: { $dateToString: { date: '$createdAt', format: '%Y-%m', timezone: 'Asia/Kolkata' } }, kind: '$kind' }, used: { $sum: { $multiply: ['$amount', -1] } } } },
  ]);
  const byKind = Object.fromEntries(MESSAGE_KINDS.map((k) => [k, 0]));
  const monthly = [];
  for (let i = months - 1; i >= 0; i -= 1) monthly.push({ period: prevPeriod(period, i), used: 0 });
  for (const r of rows) {
    const m = monthly.find((x) => x.period === r._id.month);
    if (m) m.used += r.used;
    if (r._id.month === period) byKind[r._id.kind || 'other'] += r.used;
  }
  const thisMonth = monthly[monthly.length - 1].used;
  return { period, thisMonth, byKind, monthly, nextResetOn: monthStart(nextPeriod(period)) };
}

const summaryOf = (acc) => ({
  mode: acc?.mode || 'off',
  balance: acc?.balance ?? 0,
  lowBalanceThreshold: acc?.lowBalanceThreshold ?? DEFAULT_LOW_BALANCE,
  low: (acc?.mode === 'api') && (acc?.balance ?? 0) <= (acc?.lowBalanceThreshold ?? DEFAULT_LOW_BALANCE),
  empty: (acc?.mode === 'api') && (acc?.balance ?? 0) <= 0,
});

// Society side: everyone may learn the mode (it decides whether "Send on WhatsApp" buttons show);
// credits and usage are for the committee.
export async function forSociety(ctx) {
  const acc = await WhatsAppAccount.findOne({ society: ctx.societyId }).lean();
  if (!FINANCE_VIEW.includes(ctx.role)) return { mode: acc?.mode || 'off' };
  return { ...summaryOf(acc), usage: await usage(ctx.societyId, { months: 3 }) };
}

// ---------- platform ----------
async function requireSociety(societyId) {
  const society = await Society.findById(societyId).select('name').lean();
  if (!society) throw ApiError.notFound('Society not found');
  return society;
}

export async function platformSummary(societyId) {
  const society = await requireSociety(societyId);
  const [acc, use, recent, totals] = await Promise.all([
    WhatsAppAccount.findOne({ society: society._id }).lean(),
    usage(society._id),
    WhatsAppCredit.find({ society: society._id }).sort({ createdAt: -1 }).limit(15).populate('by', 'name').lean(),
    WhatsAppCredit.aggregate([{ $match: { society: society._id } }, { $group: { _id: '$entry', total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
  ]);
  const t = Object.fromEntries(totals.map((r) => [r._id, r]));
  return {
    society,
    ...summaryOf(acc),
    usage: use,
    totals: { granted: t.grant?.total || 0, debited: -(t.debit?.total || 0), refunded: t.refund?.total || 0 },
    recent,
  };
}

export async function setMode(platformCtx, societyId, { mode, lowBalanceThreshold }) {
  const society = await requireSociety(societyId);
  const set = { updatedBy: platformCtx.userId };
  if (mode) set.mode = mode;
  if (lowBalanceThreshold !== undefined) set.lowBalanceThreshold = lowBalanceThreshold;
  await WhatsAppAccount.updateOne({ society: society._id }, { $set: set, $setOnInsert: { society: society._id } }, { upsert: true });
  return platformSummary(society._id);
}

export async function grantCredits(platformCtx, societyId, { amount, note }) {
  const society = await requireSociety(societyId);
  const acc = await WhatsAppAccount.findOneAndUpdate(
    { society: society._id },
    { $inc: { balance: amount }, $setOnInsert: { society: society._id }, $set: { updatedBy: platformCtx.userId } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  await WhatsAppCredit.create({ society: society._id, entry: 'grant', amount, note, by: platformCtx.userId, balanceAfter: acc.balance });
  // Back above the warning lines: arm the one-time notices again.
  const unset = {};
  if (acc.balance > 0) unset.emptyNotifiedAt = 1;
  if (acc.balance > acc.lowBalanceThreshold) unset.lowNotifiedAt = 1;
  if (Object.keys(unset).length) await WhatsAppAccount.updateOne({ _id: acc._id }, { $unset: unset });
  return platformSummary(society._id);
}

export async function ledger(societyId, { entry, kind }, pagination) {
  const society = await requireSociety(societyId);
  const filter = { society: society._id };
  if (entry) filter.entry = entry;
  if (kind) filter.kind = kind;
  return paginate(WhatsAppCredit, filter, pagination, { populate: { path: 'by', select: 'name' } });
}
