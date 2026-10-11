import DailyHelp from './dailyHelp.model.js';
import HelpAttendance from './helpAttendance.model.js';
import HelpReview from './helpReview.model.js';
import HelpEmployment from './helpEmployment.model.js';
import HelpLeave from './helpLeave.model.js';
import Unit from '../units/unit.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { numericCode } from '../../common/utils/codes.js';
import { addDays, localDateString, localPeriod, startOfLocalDay } from '../../common/utils/dates.js';
import { money } from '../../common/utils/money.js';
import { ROLES } from '../../common/constants/index.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyUnit } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
const isGuard = (ctx) => ctx.role === ROLES.GUARD;
const POPULATE = { path: 'units', select: 'label' };

async function uniquePasscode(societyId) {
  for (let i = 0; i < 10; i += 1) {
    const code = numericCode(6);
    // eslint-disable-next-line no-await-in-loop
    if (!(await DailyHelp.exists({ society: societyId, passcode: code }))) return code;
  }
  throw new Error('Could not generate a passcode');
}

async function assertUnits(societyId, unitIds) {
  const count = await Unit.countDocuments({ society: societyId, _id: { $in: unitIds } });
  if (count !== unitIds.length) throw ApiError.badRequest('One or more units are invalid');
}

export async function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.units = ctx.unitId;
  if (filters.type) filter.type = filters.type;
  if (filters.inside !== undefined) filter.isInside = filters.inside;
  if (filters.search) {
    const rx = { $regex: escapeRegex(filters.search), $options: 'i' };
    filter.$or = [{ name: rx }, { phone: rx }];
  }
  const result = await paginate(DailyHelp, filter, pagination, { sort: { name: 1 }, populate: POPULATE });
  result.items = await decorate(ctx, result.items);
  return result;
}

// Adds what the viewer may see: a household gets its own salary settings, review and today's leave;
// guards never get the helper's documents.
async function decorate(ctx, items) {
  if (isGuard(ctx)) return items.map(({ documents, ...h }) => h);
  if (!isResident(ctx) || !items.length) return items;
  const ids = items.map((h) => h._id);
  const today = localDateString();
  const [jobs, reviews, leaves] = await Promise.all([
    HelpEmployment.find({ society: ctx.societyId, unit: ctx.unitId, help: { $in: ids } }).lean(),
    HelpReview.find({ society: ctx.societyId, unit: ctx.unitId, help: { $in: ids } }).lean(),
    HelpLeave.find({ society: ctx.societyId, help: { $in: ids }, date: today, $or: [{ unit: ctx.unitId }, { unit: null }] }).lean(),
  ]);
  const by = (rows) => new Map(rows.map((r) => [String(r.help), r]));
  const jobMap = by(jobs);
  const reviewMap = by(reviews);
  return items.map((h) => ({
    ...h,
    myEmployment: jobMap.get(String(h._id)) || null,
    myReview: reviewMap.get(String(h._id)) || null,
    awayToday: leaves.find((l) => String(l.help) === String(h._id)) || null,
  }));
}

// A resident adding a helper who already works in the society (same phone) gets linked, not duplicated.
export async function create(ctx, data) {
  if (isResident(ctx)) {
    if (data.phone) {
      const existing = await DailyHelp.findOneAndUpdate(
        { society: ctx.societyId, phone: data.phone },
        { $addToSet: { units: ctx.unitId }, active: true },
        { returnDocument: 'after' },
      ).populate(POPULATE);
      if (existing) return existing.toObject();
    }
    data.units = [ctx.unitId];
  } else if (data.units?.length) {
    await assertUnits(ctx.societyId, data.units);
  }
  const help = await DailyHelp.create({ ...data, society: ctx.societyId, createdBy: ctx.userId, passcode: await uniquePasscode(ctx.societyId) });
  return DailyHelp.findById(help._id).populate(POPULATE).lean();
}

export async function update(ctx, id, data) {
  const help = await DailyHelp.findOne({ _id: id, society: ctx.societyId });
  if (!help) throw ApiError.notFound('Helper not found');
  if (data.units) await assertUnits(ctx.societyId, data.units);
  Object.assign(help, data);
  await help.save();
  return DailyHelp.findById(help._id).populate(POPULATE).lean();
}

// Residents "remove" a helper from their own unit only.
export async function removeFromMyUnit(ctx, id) {
  const res = await DailyHelp.updateOne({ _id: id, society: ctx.societyId, units: ctx.unitId }, { $pull: { units: ctx.unitId } });
  if (!res.matchedCount) throw ApiError.notFound('Helper not found');
}

export async function attendance(ctx, id, pagination) {
  const filter = { _id: id, society: ctx.societyId };
  if (isResident(ctx)) filter.units = ctx.unitId;
  if (!(await DailyHelp.exists(filter))) throw ApiError.notFound('Helper not found');
  return paginate(HelpAttendance, { society: ctx.societyId, help: id }, pagination, { sort: { inAt: -1 } });
}

// Guard enters the helper's passcode: toggles between entry and exit.
// occurredAt: when the guard actually scanned (offline gate console replays), never in the future.
export async function gateScan(ctx, passcode, { occurredAt } = {}) {
  const help = await DailyHelp.findOne({ society: ctx.societyId, passcode });
  if (!help) throw ApiError.notFound('No helper with this passcode');
  if (!help.active) throw ApiError.forbidden('This helper has been deactivated');
  const now = occurredAt && new Date(occurredAt) < new Date() ? new Date(occurredAt) : new Date();

  let direction;
  if (help.isInside) {
    await HelpAttendance.findOneAndUpdate({ society: ctx.societyId, help: help._id, outAt: null }, { outAt: now }, { sort: { inAt: -1 } });
    direction = 'out';
  } else {
    await HelpAttendance.create({ society: ctx.societyId, help: help._id, inAt: now, markedBy: ctx.userId });
    direction = 'in';
  }
  help.isInside = direction === 'in';
  help.lastSeenAt = now;
  await help.save();

  await Promise.all(
    help.units.map((unitId) =>
      notifyUnit(ctx.societyId, unitId, {
        type: 'visitor',
        title: `${help.name} ${direction === 'in' ? 'entered' : 'left'}`,
        body: `Daily help (${help.type})`,
        link: '/daily-help',
      }),
    ),
  );
  invalidate(ctx.societyId, ['dailyHelp', 'dashboard'], { roles: ['guard'] });
  const populated = await DailyHelp.findById(help._id).populate(POPULATE).lean();
  return { direction, help: populated };
}

// ---------- helper profile, reviews, salary, leave, documents ----------
async function loadHelp(ctx, id, { linkedOnly = isResident(ctx) } = {}) {
  const filter = { _id: id, society: ctx.societyId };
  if (linkedOnly) filter.units = ctx.unitId;
  const help = await DailyHelp.findOne(filter);
  if (!help) throw ApiError.notFound('Helper not found');
  return help;
}

export async function getById(ctx, id) {
  const help = await loadHelp(ctx, id);
  const doc = await DailyHelp.findById(help._id).populate(POPULATE).populate('policeVerification.verifiedBy', 'name').lean();
  const [decorated] = await decorate(ctx, [doc]);
  return decorated;
}

async function refreshRating(societyId, helpId) {
  const [agg] = await HelpReview.aggregate([
    { $match: { society: societyId, help: helpId } },
    { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } },
  ]);
  await DailyHelp.updateOne({ _id: helpId }, { avgRating: agg ? Math.round(agg.avg * 10) / 10 : null, ratingCount: agg?.n || 0 });
}

export async function listReviews(ctx, id, pagination) {
  const help = await loadHelp(ctx, id);
  const result = await paginate(HelpReview, { society: ctx.societyId, help: help._id }, pagination, {
    sort: { updatedAt: -1 },
    populate: [{ path: 'user', select: 'name' }, { path: 'unit', select: 'label' }],
  });
  result.meta.avgRating = help.avgRating;
  result.meta.ratingCount = help.ratingCount;
  return result;
}

// One review per household; rating again updates it.
export async function review(ctx, id, { rating, text }) {
  const help = await loadHelp(ctx, id, { linkedOnly: true });
  const doc = await HelpReview.findOneAndUpdate(
    { society: ctx.societyId, help: help._id, unit: ctx.unitId },
    { rating, text, user: ctx.userId },
    { upsert: true, returnDocument: 'after', runValidators: true },
  ).lean();
  await refreshRating(help.society, help._id);
  const totals = await DailyHelp.findById(help._id).select('avgRating ratingCount').lean();
  return { review: doc, avgRating: totals.avgRating, ratingCount: totals.ratingCount };
}

export async function removeReview(ctx, id) {
  const help = await loadHelp(ctx, id, { linkedOnly: true });
  const res = await HelpReview.deleteOne({ society: ctx.societyId, help: help._id, unit: ctx.unitId });
  if (!res.deletedCount) throw ApiError.notFound('You have not reviewed this helper');
  await refreshRating(help.society, help._id);
}

export async function setEmployment(ctx, id, data) {
  const help = await loadHelp(ctx, id, { linkedOnly: true });
  return HelpEmployment.findOneAndUpdate(
    { society: ctx.societyId, help: help._id, unit: ctx.unitId },
    { $set: { ...data, updatedBy: ctx.userId } },
    { upsert: true, returnDocument: 'after', runValidators: true },
  ).lean();
}

export async function markSalaryPaid(ctx, id, { period } = {}) {
  const help = await loadHelp(ctx, id, { linkedOnly: true });
  const job = await HelpEmployment.findOneAndUpdate(
    { society: ctx.societyId, help: help._id, unit: ctx.unitId },
    { lastPaidPeriod: period || localPeriod(), lastPaidAt: new Date(), updatedBy: ctx.userId },
    { returnDocument: 'after' },
  ).lean();
  if (!job) throw ApiError.badRequest('Set the salary details first');
  return job;
}

export async function listLeaves(ctx, id, { from, to }, pagination) {
  const help = await loadHelp(ctx, id);
  const filter = { society: ctx.societyId, help: help._id };
  if (isResident(ctx)) filter.$or = [{ unit: ctx.unitId }, { unit: null }];
  if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  return paginate(HelpLeave, filter, pagination, {
    sort: { date: -1 },
    populate: [{ path: 'unit', select: 'label' }, { path: 'markedBy', select: 'name' }],
  });
}

// A household marks the helper away (planned leave, or did not turn up). When it is for today the
// other homes they work at are told, so nobody waits for them.
export async function addLeave(ctx, id, { date, kind, reason }) {
  const help = await loadHelp(ctx, id, { linkedOnly: true });
  let leave;
  try {
    leave = await HelpLeave.create({ society: ctx.societyId, help: help._id, unit: ctx.unitId, date, kind, reason, source: 'household', markedBy: ctx.userId });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('Already marked for this day');
    throw err;
  }
  if (date === localDateString()) {
    const others = help.units.filter((u) => String(u) !== String(ctx.unitId));
    await Promise.all(
      others.map((unitId) =>
        notifyUnit(ctx.societyId, unitId, {
          type: 'dailyHelp',
          title: `${help.name} is ${kind === 'leave' ? 'on leave' : 'absent'} today`,
          body: reason || 'Marked by another household',
          link: '/daily-help',
        }),
      ),
    );
  }
  return leave.toObject();
}

export async function removeLeave(ctx, id, leaveId) {
  const help = await loadHelp(ctx, id, { linkedOnly: true });
  const res = await HelpLeave.deleteOne({ _id: leaveId, society: ctx.societyId, help: help._id, unit: ctx.unitId });
  if (!res.deletedCount) throw ApiError.notFound('Leave entry not found');
}

export async function addDocuments(ctx, id, { kind, files }) {
  const help = await loadHelp(ctx, id);
  const attachments = await uploads.resolve(ctx, files);
  if (kind === 'photo') help.photo = attachments[0];
  help.documents.push({ kind, files: attachments, uploadedBy: ctx.userId });
  if (kind === 'police_verification' && ['not_submitted', 'rejected'].includes(help.policeVerification?.status || 'not_submitted')) {
    help.policeVerification.status = 'submitted';
  }
  await help.save();
  return getById(ctx, help._id);
}

export async function setVerification(ctx, id, { status, notes }) {
  const help = await loadHelp(ctx, id, { linkedOnly: false });
  help.policeVerification.status = status;
  help.policeVerification.notes = notes;
  help.policeVerification.verifiedAt = status === 'verified' ? new Date() : undefined;
  help.policeVerification.verifiedBy = status === 'verified' ? ctx.userId : undefined;
  await help.save();
  audit.record(ctx, 'dailyHelp.verification', 'DailyHelp', help._id, { status });
  await Promise.all(
    help.units.map((unitId) =>
      notifyUnit(ctx.societyId, unitId, {
        type: 'dailyHelp',
        title: `Police verification of ${help.name}: ${status.replace('_', ' ')}`,
        body: notes || '',
        link: '/daily-help',
      }),
    ),
  );
  return getById(ctx, help._id);
}

// ---------- scheduled ----------
// From the due day on, each household with reminders on is told once a month (unless already marked paid).
export async function salaryReminders(now = new Date()) {
  const period = localPeriod(now);
  const day = Number(localDateString(now).slice(8, 10));
  const jobs = await HelpEmployment.find({
    remindersOn: true,
    salary: { $gt: 0 },
    dueDay: { $lte: day },
    lastRemindedPeriod: { $ne: period },
    lastPaidPeriod: { $ne: period },
  })
    .populate('help', 'name units active')
    .limit(5000)
    .lean();
  let reminded = 0;
  for (const j of jobs) {
    const stillWorks = j.help?.active && j.help.units.some((u) => String(u) === String(j.unit));
    if (!stillWorks) continue;
    // eslint-disable-next-line no-await-in-loop
    await notifyUnit(j.society, j.unit, {
      type: 'dailyHelp',
      title: `Salary due for ${j.help.name}`,
      body: `${money(j.salary)} was due on day ${j.dueDay} of this month`,
      link: '/daily-help',
    });
    reminded += 1;
  }
  if (jobs.length) await HelpEmployment.updateMany({ _id: { $in: jobs.map((j) => j._id) } }, { lastRemindedPeriod: period });
  return { reminded };
}

const NOON_MINUTES = 12 * 60;
const minutesIST = (d) => {
  const [h, m] = new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).split(':').map(Number);
  return (h % 24) * 60 + m;
};

// After noon (IST): regular helpers (seen at the gate in the last 14 days) with no entry today are
// recorded absent once, and every linked household that has not already marked them away is told.
export async function autoAbsent(now = new Date()) {
  if (minutesIST(now) < NOON_MINUTES) return { skipped: true, absent: 0 };
  const today = localDateString(now);
  const dayStart = startOfLocalDay(now);
  const regulars = await DailyHelp.find({
    active: true,
    isInside: false,
    'units.0': { $exists: true },
    lastSeenAt: { $gte: addDays(dayStart, -14), $lt: dayStart },
  })
    .select('society name units')
    .limit(5000)
    .lean();
  if (!regulars.length) return { absent: 0 };
  const ids = regulars.map((h) => h._id);
  const [cameToday, marked] = await Promise.all([
    HelpAttendance.distinct('help', { help: { $in: ids }, inAt: { $gte: dayStart } }),
    HelpLeave.find({ help: { $in: ids }, date: today }).select('help unit source').lean(),
  ]);
  const present = new Set(cameToday.map(String));
  let absent = 0;
  for (const h of regulars) {
    const mine = marked.filter((l) => String(l.help) === String(h._id));
    if (present.has(String(h._id)) || mine.some((l) => l.source === 'auto')) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await HelpLeave.create({ society: h.society, help: h._id, unit: null, date: today, kind: 'absent', source: 'auto', reason: 'No gate entry by noon' });
    } catch (err) {
      if (err.code === 11000) continue; // another instance got there first
      throw err;
    }
    const informed = new Set(mine.filter((l) => l.unit).map((l) => String(l.unit)));
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      h.units
        .filter((u) => !informed.has(String(u)))
        .map((unitId) =>
          notifyUnit(h.society, unitId, { type: 'dailyHelp', title: `${h.name} is absent today`, body: 'No gate entry recorded by noon', link: '/daily-help' }),
        ),
    );
    absent += 1;
  }
  return { absent };
}
