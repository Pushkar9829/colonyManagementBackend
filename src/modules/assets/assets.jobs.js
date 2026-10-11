import Asset from './asset.model.js';
import FireExtinguisher from './fireExtinguisher.model.js';
import FireNoc from './fireNoc.model.js';
import Society from '../society/society.model.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { ROLES } from '../../common/constants/index.js';
import { addDaysStr, diffDays, EXPIRY_ALERT_DAYS, today } from './facility.shared.js';

const HOUR = 60 * 60 * 1000;
const MANAGERS = [ROLES.ADMIN, ROLES.FACILITY_MANAGER];
const MAX_THRESHOLD = Math.max(...EXPIRY_ALERT_DAYS);

// Which reminder is due for an expiry date. Uses the nearest threshold already reached so a server that
// slept through "7 days before" still sends one reminder, never a burst of 30 + 7 + 1 at once.
// Returns { key, keysToMark, daysLeft } or null when nothing is due.
export function dueReminder(kind, dateStr, sent, t) {
  const daysLeft = diffDays(t, dateStr);
  if (daysLeft > MAX_THRESHOLD) return null;
  const thresholds = [...EXPIRY_ALERT_DAYS, 0].sort((a, b) => a - b);
  const reached = thresholds.find((d) => daysLeft <= d);
  if (reached === undefined) return null;
  const key = `${kind}:${dateStr}:${reached}`;
  if (sent.includes(key)) return null;
  const keysToMark = thresholds.filter((d) => d >= reached).map((d) => `${kind}:${dateStr}:${d}`);
  return { key, keysToMark, daysLeft };
}

const whenText = (daysLeft) => (daysLeft < 0 ? `expired ${-daysLeft} day(s) ago` : daysLeft === 0 ? 'expires today' : `expires in ${daysLeft} day(s)`);

async function remind(model, doc, items, t) {
  const marks = [];
  for (const { kind, dateStr, title, body, link } of items) {
    if (!dateStr) continue;
    const due = dueReminder(kind, dateStr, doc.alertsSent || [], t);
    if (!due) continue;
    // eslint-disable-next-line no-await-in-loop
    await notifyRoles(doc.society, MANAGERS, {
      type: 'facility',
      title: `${title} ${whenText(due.daysLeft)}`,
      body,
      link,
      channels: ['inapp', 'push', 'email'],
    });
    marks.push(...due.keysToMark);
  }
  if (marks.length) await model.updateOne({ _id: doc._id }, { $addToSet: { alertsSent: { $each: marks } } });
  return marks.length ? 1 : 0;
}

// AMC and warranty reminders 30 / 7 / 1 days before expiry (and once when expired).
export async function amcWarrantyAlerts(now = new Date()) {
  const t = today(now);
  const window = { $gte: addDaysStr(t, -30), $lte: addDaysStr(t, MAX_THRESHOLD) };
  const societies = (await Society.find({ active: true }).select('_id').lean()).map((s) => s._id);
  const assets = await Asset.find({ society: { $in: societies }, status: { $ne: 'retired' }, $or: [{ 'amc.endDate': window }, { warrantyExpiry: window }] })
    .select('society name code amc.endDate amc.vendorName amc.contractNumber warrantyExpiry alertsSent')
    .limit(5000)
    .lean();
  let sent = 0;
  for (const a of assets) {
    // eslint-disable-next-line no-await-in-loop
    sent += await remind(Asset, a, [
      { kind: 'amc', dateStr: a.amc?.endDate, title: `AMC for ${a.name} (${a.code})`, body: `${a.amc?.vendorName || 'Vendor'}${a.amc?.contractNumber ? ` · ${a.amc.contractNumber}` : ''} · ends ${a.amc?.endDate}`, link: `/assets/${a._id}` },
      { kind: 'warranty', dateStr: a.warrantyExpiry, title: `Warranty for ${a.name} (${a.code})`, body: `Warranty ends ${a.warrantyExpiry}`, link: `/assets/${a._id}` },
    ], t);
  }
  return { checked: assets.length, alerted: sent };
}

// Fire NOC expiry and extinguisher refill / expiry reminders.
export async function fireSafetyAlerts(now = new Date()) {
  const t = today(now);
  const window = { $gte: addDaysStr(t, -30), $lte: addDaysStr(t, MAX_THRESHOLD) };
  const societies = (await Society.find({ active: true }).select('_id').lean()).map((s) => s._id);
  let alerted = 0;

  const extinguishers = await FireExtinguisher.find({ society: { $in: societies }, active: true, $or: [{ nextRefillDue: window }, { expiryDate: window }] }).limit(5000).lean();
  for (const e of extinguishers) {
    // eslint-disable-next-line no-await-in-loop
    alerted += await remind(FireExtinguisher, e, [
      { kind: 'refill', dateStr: e.nextRefillDue, title: `Extinguisher ${e.code} refill`, body: `${e.location} · refill due ${e.nextRefillDue}`, link: '/fire-safety' },
      { kind: 'expiry', dateStr: e.expiryDate, title: `Extinguisher ${e.code}`, body: `${e.location} · cylinder expiry ${e.expiryDate}`, link: '/fire-safety' },
    ], t);
  }

  // Only the latest NOC of a society matters; an older one being "expired" is expected after renewal.
  const latest = await FireNoc.aggregate([
    { $match: { society: { $in: societies } } },
    { $sort: { expiryDate: -1 } },
    { $group: { _id: '$society', doc: { $first: '$$ROOT' } } },
  ]);
  for (const { doc } of latest) {
    if (doc.expiryDate < window.$gte || doc.expiryDate > window.$lte) continue;
    // eslint-disable-next-line no-await-in-loop
    alerted += await remind(FireNoc, doc, [{ kind: 'noc', dateStr: doc.expiryDate, title: `Fire NOC ${doc.number}`, body: `Issued by ${doc.issuedBy || 'fire department'} · valid till ${doc.expiryDate}`, link: '/fire-safety' }], t);
  }
  return { extinguishers: extinguishers.length, alerted };
}

export const ASSET_JOBS = [
  { name: 'facility-amc-warranty-alerts', everyMs: 6 * HOUR, run: () => amcWarrantyAlerts() },
  { name: 'facility-fire-safety-alerts', everyMs: 6 * HOUR, run: () => fireSafetyAlerts() },
];
