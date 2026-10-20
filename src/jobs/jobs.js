import Society from '../modules/society/society.model.js';
import Bill from '../modules/billing/bill.model.js';
import Complaint from '../modules/complaints/complaint.model.js';
import GuestPass from '../modules/visitors/guestPass.model.js';
import * as billing from '../modules/billing/billing.service.js';
import { notifyRoles, notifyUnit } from '../modules/notifications/notifications.service.js';
import { ROLES } from '../common/constants/index.js';
import { addDays, localDateString, localPeriod } from '../common/utils/dates.js';
import { money } from '../common/utils/money.js';
import { MODULE_JOBS } from './registry.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const ACTIVE_COMPLAINT = ['open', 'assigned', 'in_progress', 'on_hold', 'reopened'];

// System context for service calls made by jobs (no human actor).
const systemCtx = (societyId) => ({ societyId, userId: null, role: ROLES.ADMIN, unitId: null, ip: 'scheduler' });
const activeSocieties = (filter = {}) => Society.find({ active: true, ...filter }).select('_id name settings').lean();

export async function expirePasses() {
  const res = await GuestPass.updateMany({ status: 'active', validTo: { $lt: new Date() } }, { status: 'expired' });
  return { expired: res.modifiedCount };
}

// Generates this month's bills on the configured day for societies that opted in.
export async function autoGenerateBills(now = new Date()) {
  const day = Number(localDateString(now).slice(8, 10));
  const period = localPeriod(now);
  const societies = await activeSocieties({ 'settings.billing.autoGenerate': true, 'settings.billing.generateDay': { $lte: day } });
  let created = 0;
  for (const s of societies) {
    // eslint-disable-next-line no-await-in-loop
    if (await Bill.exists({ society: s._id, period })) continue; // already generated (manually or earlier)
    // eslint-disable-next-line no-await-in-loop
    const r = await billing.generate(systemCtx(s._id), { period }).catch(() => ({ created: 0 }));
    created += r.created;
  }
  return { societies: societies.length, created };
}

export async function applyLateFees() {
  const societies = await activeSocieties({ 'settings.billing.lateFeeType': { $ne: 'none' } });
  let updated = 0;
  for (const s of societies) {
    // eslint-disable-next-line no-await-in-loop
    updated += (await billing.applyLateFees(systemCtx(s._id))).updated;
  }
  return { updated };
}

// Reminds households 3 days before the due date, then every 3 days while overdue.
export async function duesReminders(now = new Date()) {
  const soon = addDays(now, 3);
  const bills = await Bill.find({
    status: { $in: ['unpaid', 'partial'] },
    dueDate: { $lte: soon },
    $or: [{ lastReminderAt: null }, { lastReminderAt: { $lte: addDays(now, -3) } }],
  })
    .select('society unit period total paid dueDate')
    .limit(5000)
    .lean();
  for (const b of bills) {
    const overdue = b.dueDate < now;
    // eslint-disable-next-line no-await-in-loop
    await notifyUnit(b.society, b.unit, {
      type: 'bill',
      title: overdue ? `Maintenance for ${b.period} is overdue` : `Maintenance for ${b.period} is due soon`,
      body: `${money(b.total - b.paid)} ${overdue ? 'was' : 'is'} due on ${localDateString(b.dueDate)}`,
      link: '/billing',
      channels: overdue ? ['inapp', 'push', 'sms', 'whatsapp'] : ['inapp', 'push', 'whatsapp'],
      waKind: 'reminder',
    });
  }
  if (bills.length) await Bill.updateMany({ _id: { $in: bills.map((b) => b._id) } }, { lastReminderAt: now });
  return { reminded: bills.length };
}

// Tells managers once when a complaint breaches its SLA.
export async function slaEscalations(now = new Date()) {
  const breached = await Complaint.find({ status: { $in: ACTIVE_COMPLAINT }, slaDueAt: { $lt: now }, slaEscalatedAt: null })
    .select('society ticketNumber title priority')
    .limit(1000)
    .lean();
  for (const c of breached) {
    // eslint-disable-next-line no-await-in-loop
    await notifyRoles(c.society, [ROLES.ADMIN, ROLES.FACILITY_MANAGER], {
      type: 'complaint',
      title: `SLA breached: ${c.ticketNumber}`,
      body: `${c.priority} priority · ${c.title}`,
      link: `/complaints/${c._id}`,
      channels: ['inapp', 'push'],
    });
  }
  if (breached.length) await Complaint.updateMany({ _id: { $in: breached.map((c) => c._id) } }, { slaEscalatedAt: now });
  return { escalated: breached.length };
}

// Feature modules register their scheduled jobs in ./registry.js
export const JOBS = [
  ...MODULE_JOBS,
  { name: 'expire-passes', everyMs: 10 * MIN, run: expirePasses },
  // SLA breach alerts now come from the complaints escalation-matrix job (modules/complaints), whose default
  // rules notify facility managers at breach. slaEscalations() stays exported for direct use.
  { name: 'auto-generate-bills', everyMs: 6 * HOUR, run: () => autoGenerateBills() },
  { name: 'apply-late-fees', everyMs: 24 * HOUR, run: applyLateFees },
  { name: 'dues-reminders', everyMs: 24 * HOUR, run: () => duesReminders() },
];
