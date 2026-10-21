import Attendance from './attendance.model.js';
import Employee from './employee.model.js';
import RosterWeek from './rosterWeek.model.js';
import StaffShift from './staffShift.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { localDateString, toMinutes } from '../../common/utils/dates.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { invalidate } from '../../realtime/socket.js';
import { addDaysStr, distanceMetres, istInstant, periodDates, today, weekday, workbookBuffer } from '../assets/facility.shared.js';
import { findMine, getSettings } from './employees.service.js';

const POPULATE = [
  { path: 'employee', select: 'employeeCode designation department', populate: { path: 'user', select: 'name' } },
  { path: 'shift', select: 'name start end' },
  { path: 'markedBy', select: 'name' },
];

// IST wall-clock minutes since midnight of an instant.
const istMinutes = (d) => {
  const [h, m] = new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number);
  return (h % 24) * 60 + m;
};

export const weekStartOf = (date) => addDaysStr(date, -((weekday(date) + 6) % 7));

// ---------------------------------------------------------------- roster

// The shift an employee works on a date: the published roster wins, else default shift + weekly off.
// Returns { off: true } for a day off, { shift } (may be null = working day without fixed hours).
export function resolveShift(employee, date, rosterByEmployee, shiftsById) {
  const roster = rosterByEmployee?.get(String(employee._id));
  if (roster) {
    const id = roster.shifts[(weekday(date) + 6) % 7];
    return id ? { shift: shiftsById.get(String(id)) || null } : { off: true };
  }
  if (weekday(date) === employee.weeklyOff) return { off: true };
  return { shift: employee.defaultShift ? shiftsById.get(String(employee.defaultShift)) || null : null };
}

async function rosterContext(societyId, date, employeeIds) {
  const [rosters, shifts] = await Promise.all([
    RosterWeek.find({ society: societyId, weekStart: weekStartOf(date), ...(employeeIds && { employee: { $in: employeeIds } }) }).lean(),
    StaffShift.find({ society: societyId }).lean(),
  ]);
  return { rosterByEmployee: new Map(rosters.map((r) => [String(r.employee), r])), shiftsById: new Map(shifts.map((s) => [String(s._id), s])) };
}

export async function shiftFor(societyId, employee, date) {
  const { rosterByEmployee, shiftsById } = await rosterContext(societyId, date, [employee._id]);
  return resolveShift(employee, date, rosterByEmployee, shiftsById);
}

export async function getRoster(ctx, { weekStart }) {
  const employees = await Employee.find({ society: ctx.societyId, status: 'active' }).select('employeeCode designation department defaultShift weeklyOff').populate({ path: 'user', select: 'name' }).sort({ employeeCode: 1 }).lean();
  const { rosterByEmployee, shiftsById } = await rosterContext(ctx.societyId, weekStart);
  const dates = Array.from({ length: 7 }, (_, i) => addDaysStr(weekStart, i));
  return {
    weekStart,
    dates,
    shifts: [...shiftsById.values()].filter((s) => s.active),
    rows: employees.map((e) => {
      const published = rosterByEmployee.get(String(e._id));
      return {
        employee: e,
        published: Boolean(published),
        shifts: dates.map((d) => {
          const r = resolveShift(e, d, rosterByEmployee, shiftsById);
          return r.off ? null : r.shift?._id || null;
        }),
      };
    }),
  };
}

export async function saveRoster(ctx, { weekStart, assignments }) {
  const empIds = assignments.map((a) => a.employee);
  const shiftIds = [...new Set(assignments.flatMap((a) => a.shifts).filter(Boolean))];
  const [empCount, shiftCount] = await Promise.all([
    Employee.countDocuments({ society: ctx.societyId, _id: { $in: empIds } }),
    StaffShift.countDocuments({ society: ctx.societyId, _id: { $in: shiftIds } }),
  ]);
  if (empCount !== new Set(empIds).size) throw ApiError.badRequest('One or more employees are not in this society');
  if (shiftCount !== shiftIds.length) throw ApiError.badRequest('One or more shifts are not in this society');
  await RosterWeek.bulkWrite(
    assignments.map((a) => ({
      updateOne: {
        filter: { society: ctx.societyId, weekStart, employee: a.employee },
        update: { $set: { shifts: a.shifts, updatedBy: ctx.userId } },
        upsert: true,
      },
    })),
  );
  audit.record(ctx, 'staffhr.roster_saved', 'RosterWeek', null, { weekStart, employees: assignments.length });
  invalidate(ctx.societyId, ['staffhr'], { roles: ['staff', 'guard'] });
  return getRoster(ctx, { weekStart });
}

// ---------------------------------------------------------------- self check-in / out

async function geofenceCheck(settings, { lat, lng, accuracy }) {
  const g = settings.geofence || {};
  if (!g.enabled) return lat !== undefined && g.lat !== undefined && g.lng !== undefined ? { distanceM: distanceMetres(g.lat, g.lng, lat, lng) } : {};
  if (lat === undefined || lng === undefined) throw new ApiError(400, 'LOCATION_REQUIRED', 'Turn on location to mark attendance');
  const distanceM = distanceMetres(g.lat, g.lng, lat, lng);
  // GPS on phones drifts; give the reported accuracy some benefit, capped so a bad fix can't open the fence.
  const allowance = g.radiusM + Math.min(accuracy || 0, 50);
  if (distanceM > allowance) throw new ApiError(403, 'OUTSIDE_GEOFENCE', 'You are {distance} m from the society; check-in is allowed within {radius} m', { params: { distance: distanceM, radius: g.radiusM } });
  return { distanceM };
}

async function selfPunch(ctx, settings, { photo, lat, lng, accuracy }) {
  if (settings.requireSelfie && !photo) throw new ApiError(400, 'SELFIE_REQUIRED', 'Take a selfie to mark attendance');
  const geo = await geofenceCheck(settings, { lat, lng, accuracy });
  const [photoDoc] = photo ? await uploads.resolve(ctx, [photo]) : [];
  return { at: new Date(), source: 'self', photo: photoDoc, lat, lng, accuracy, ...geo };
}

function lateness(shift, at, graceMinutes) {
  if (!shift) return { status: 'present', lateMinutes: 0 };
  const late = istMinutes(at) - toMinutes(shift.start);
  // A negative value larger than half a day means the punch is for a shift that started "yesterday".
  const lateMinutes = late > 0 && late < 12 * 60 ? late : 0;
  return { status: lateMinutes > graceMinutes ? 'late' : 'present', lateMinutes };
}

async function applyCheckIn(societyId, employee, punch, settings) {
  const date = localDateString(punch.at);
  const existing = await Attendance.findOne({ society: societyId, employee: employee._id, date });
  if (existing?.checkIn?.at) throw ApiError.conflict('Already checked in today');
  if (existing?.status === 'on_leave' && existing.leaveDays === 1) throw ApiError.conflict('You are on approved leave today');
  const { shift } = await shiftFor(societyId, employee, date);
  const { status, lateMinutes } = lateness(shift, punch.at, settings.lateGraceMinutes ?? 15);
  const doc = existing || new Attendance({ society: societyId, employee: employee._id, user: employee.user._id || employee.user, date });
  doc.set({ checkIn: punch, status, lateMinutes, shift: shift?._id, shiftStart: shift?.start, shiftEnd: shift?.end, autoMarked: false });
  await doc.save();
  return doc;
}

// Check-out closes today's record, or last night's for a shift that ran past midnight.
async function applyCheckOut(societyId, employee, punch, settings) {
  const date = localDateString(punch.at);
  let doc = await Attendance.findOne({ society: societyId, employee: employee._id, date, 'checkIn.at': { $exists: true } });
  if (!doc) {
    const prev = await Attendance.findOne({ society: societyId, employee: employee._id, date: addDaysStr(date, -1), 'checkIn.at': { $exists: true }, 'checkOut.at': { $exists: false } });
    if (prev && punch.at - prev.checkIn.at < 18 * 3600 * 1000) doc = prev;
  }
  if (!doc) throw ApiError.conflict('Check in first');
  if (doc.checkOut?.at && punch.source === 'self') throw ApiError.conflict('Already checked out');
  const workedMinutes = Math.max(0, Math.round((punch.at - doc.checkIn.at) / 60000));
  doc.set({ checkOut: punch, workedMinutes });
  if (['present', 'late'].includes(doc.status) && workedMinutes < (settings.halfDayMinutes ?? 240)) doc.status = 'half_day';
  else if (doc.status === 'half_day' && !doc.leave && workedMinutes >= (settings.halfDayMinutes ?? 240)) doc.status = doc.lateMinutes > (settings.lateGraceMinutes ?? 15) ? 'late' : 'present';
  await doc.save();
  return doc;
}

const reload = (id) => Attendance.findById(id).populate(POPULATE).lean();

export async function checkIn(ctx, body) {
  const employee = await findMine(ctx);
  const settings = await getSettings(ctx);
  const punch = await selfPunch(ctx, settings, body);
  const doc = await applyCheckIn(ctx.societyId, employee, punch, settings);
  invalidate(ctx.societyId, ['attendance'], { roles: [] });
  return reload(doc._id);
}

export async function checkOut(ctx, body) {
  const employee = await findMine(ctx);
  const settings = await getSettings(ctx);
  const punch = await selfPunch(ctx, settings, body);
  const doc = await applyCheckOut(ctx.societyId, employee, punch, settings);
  invalidate(ctx.societyId, ['attendance'], { roles: [] });
  return reload(doc._id);
}

export async function myToday(ctx) {
  const employee = await findMine(ctx, { required: false });
  if (!employee) return { employee: null };
  const t = today();
  const [record, open, { shift, off }, settings] = await Promise.all([
    Attendance.findOne({ society: ctx.societyId, employee: employee._id, date: t }).populate(POPULATE).lean(),
    Attendance.findOne({ society: ctx.societyId, employee: employee._id, date: addDaysStr(t, -1), 'checkIn.at': { $exists: true }, 'checkOut.at': { $exists: false } }).select('date checkIn').lean(),
    shiftFor(ctx.societyId, employee, t),
    getSettings(ctx),
  ]);
  return {
    employee: { _id: employee._id, employeeCode: employee.employeeCode, designation: employee.designation, name: employee.user?.name },
    date: t,
    shift: shift || null,
    dayOff: Boolean(off),
    record,
    openFromYesterday: open && Date.now() - new Date(open.checkIn.at) < 18 * 3600 * 1000 ? open : null,
    requireSelfie: settings.requireSelfie,
    geofence: settings.geofence?.enabled ? { lat: settings.geofence.lat, lng: settings.geofence.lng, radiusM: settings.geofence.radiusM } : null,
  };
}

export async function myAttendance(ctx, { period }) {
  const employee = await findMine(ctx);
  const p = period || today().slice(0, 7);
  const records = await Attendance.find({ society: ctx.societyId, employee: employee._id, date: { $gte: `${p}-01`, $lte: `${p}-31` } }).sort({ date: 1 }).populate({ path: 'shift', select: 'name start end' }).lean();
  return { period: p, records, totals: totalsOf(records) };
}

// ---------------------------------------------------------------- device punches

export async function devicePunches(ctx, { punches }, device) {
  const settings = await getSettings(ctx);
  const codes = [...new Set(punches.map((p) => p.employeeCode.toUpperCase()))];
  const employees = await Employee.find({ society: ctx.societyId, status: 'active', employeeCode: { $in: codes } }).lean();
  const byCode = new Map(employees.map((e) => [e.employeeCode, e]));
  const results = [];
  // Oldest first so an in and an out sent in one batch land in order.
  for (const p of [...punches].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    const employee = byCode.get(p.employeeCode.toUpperCase());
    if (!employee) {
      results.push({ employeeCode: p.employeeCode, at: p.at, ok: false, error: 'Unknown employee code' });
      continue;
    }
    const at = new Date(p.at);
    if (at > new Date(Date.now() + 5 * 60000)) {
      results.push({ employeeCode: p.employeeCode, at: p.at, ok: false, error: 'Punch time is in the future' });
      continue;
    }
    const punch = { at, source: 'device', device: device?._id };
    try {
      // eslint-disable-next-line no-await-in-loop
      const existing = await Attendance.findOne({ society: ctx.societyId, employee: employee._id, date: localDateString(at) }).select('checkIn checkOut').lean();
      let direction = p.direction;
      if (direction === 'auto') direction = existing?.checkIn?.at ? 'out' : 'in';
      if (direction === 'in' && existing?.checkIn?.at) {
        results.push({ employeeCode: p.employeeCode, at: p.at, ok: true, action: 'duplicate' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      if (direction === 'in') await applyCheckIn(ctx.societyId, employee, punch, settings);
      // eslint-disable-next-line no-await-in-loop
      else await applyCheckOut(ctx.societyId, employee, punch, settings);
      results.push({ employeeCode: p.employeeCode, at: p.at, ok: true, action: direction === 'in' ? 'check_in' : 'check_out' });
    } catch (err) {
      results.push({ employeeCode: p.employeeCode, at: p.at, ok: false, error: err.message });
    }
  }
  if (results.some((r) => r.ok)) invalidate(ctx.societyId, ['attendance'], { roles: [] });
  return { accepted: results.filter((r) => r.ok).length, rejected: results.filter((r) => !r.ok).length, results };
}

// ---------------------------------------------------------------- manager views

export async function markManual(ctx, { employee: employeeId, date, status, checkIn: inTime, checkOut: outTime, notes }) {
  const employee = await Employee.findOne({ _id: employeeId, society: ctx.societyId }).lean();
  if (!employee) throw ApiError.notFound('Employee not found');
  if (date > today()) throw ApiError.badRequest('Attendance cannot be marked for a future date');
  const { shift } = await shiftFor(ctx.societyId, employee, date);
  const set = { status, notes, markedBy: ctx.userId, autoMarked: false, shift: shift?._id, shiftStart: shift?.start, shiftEnd: shift?.end, leave: undefined, paidLeave: undefined, leaveDays: undefined };
  const unset = {};
  if (inTime) set.checkIn = { at: istInstant(date, inTime), source: 'manual' };
  else if (['absent', 'week_off', 'holiday'].includes(status)) unset.checkIn = 1;
  if (outTime) {
    let out = istInstant(date, outTime);
    if (inTime && outTime <= inTime) out = istInstant(addDaysStr(date, 1), outTime); // night shift
    set.checkOut = { at: out, source: 'manual' };
    if (inTime) set.workedMinutes = Math.round((out - set.checkIn.at) / 60000);
  } else if (['absent', 'week_off', 'holiday'].includes(status)) unset.checkOut = 1;
  if (inTime && shift) set.lateMinutes = lateness(shift, set.checkIn.at, 0).lateMinutes;
  for (const k of Object.keys(set)) if (set[k] === undefined) { delete set[k]; unset[k] = 1; }
  const doc = await Attendance.findOneAndUpdate(
    { society: ctx.societyId, employee: employee._id, date },
    { $set: set, ...(Object.keys(unset).length && { $unset: unset }), $setOnInsert: { user: employee.user } },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );
  audit.record(ctx, 'attendance.marked', 'Attendance', doc._id, { employee: employee.employeeCode, date, status });
  return reload(doc._id);
}

export function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.date) filter.date = filters.date;
  if (filters.from || filters.to) filter.date = { ...(filters.from && { $gte: filters.from }), ...(filters.to && { $lte: filters.to }) };
  if (filters.employee) filter.employee = filters.employee;
  if (filters.status) filter.status = filters.status;
  return paginate(Attendance, filter, pagination, { sort: { date: -1, createdAt: -1 }, populate: POPULATE });
}

// Today at a glance: who is in, late, absent or on leave, and who has not punched yet.
export async function daySheet(ctx, date = today()) {
  const employees = await Employee.find({ society: ctx.societyId, status: 'active' }).populate({ path: 'user', select: 'name phone' }).sort({ employeeCode: 1 }).lean();
  const [records, rc] = await Promise.all([Attendance.find({ society: ctx.societyId, date }).lean(), rosterContext(ctx.societyId, date)]);
  const byEmp = new Map(records.map((r) => [String(r.employee), r]));
  const rows = employees.map((e) => {
    const r = resolveShift(e, date, rc.rosterByEmployee, rc.shiftsById);
    return { employee: { _id: e._id, employeeCode: e.employeeCode, name: e.user?.name, designation: e.designation, phone: e.user?.phone }, shift: r.shift || null, dayOff: Boolean(r.off), record: byEmp.get(String(e._id)) || null };
  });
  const count = (fn) => rows.filter(fn).length;
  return {
    date,
    rows,
    totals: {
      employees: rows.length,
      in: count((x) => x.record?.checkIn && !x.record?.checkOut),
      present: count((x) => ['present', 'late', 'half_day'].includes(x.record?.status)),
      late: count((x) => x.record?.status === 'late'),
      onLeave: count((x) => x.record?.status === 'on_leave'),
      absent: count((x) => x.record?.status === 'absent'),
      notMarked: count((x) => !x.record && !x.dayOff),
    },
  };
}

// ---------------------------------------------------------------- register

const CODE = { present: 'P', late: 'L', half_day: 'H', absent: 'A', week_off: 'WO', holiday: 'HO' };
const codeOf = (r) => (r.status === 'on_leave' ? (r.paidLeave === false ? 'LOP' : r.leaveDays === 0.5 ? 'HL' : 'LV') : CODE[r.status]);

export function totalsOf(records) {
  const t = { present: 0, late: 0, halfDay: 0, absent: 0, paidLeave: 0, unpaidLeave: 0, weekOff: 0, holiday: 0, lateMinutes: 0, workedMinutes: 0 };
  for (const r of records) {
    if (r.status === 'present') t.present += 1;
    if (r.status === 'late') t.late += 1;
    if (r.status === 'half_day') t.halfDay += 1;
    if (r.status === 'absent') t.absent += 1;
    if (r.status === 'week_off') t.weekOff += 1;
    if (r.status === 'holiday') t.holiday += 1;
    if (r.status === 'on_leave') {
      if (r.paidLeave === false) t.unpaidLeave += r.leaveDays || 1;
      else t.paidLeave += r.leaveDays || 1;
    }
    t.lateMinutes += r.lateMinutes || 0;
    t.workedMinutes += r.workedMinutes || 0;
  }
  return t;
}

export async function register(ctx, { period }) {
  const dates = periodDates(period);
  const [employees, records] = await Promise.all([
    Employee.find({ society: ctx.societyId, $or: [{ status: 'active' }, { dateOfExit: { $gte: dates[0] } }] }).populate({ path: 'user', select: 'name' }).sort({ employeeCode: 1 }).lean(),
    Attendance.find({ society: ctx.societyId, date: { $gte: dates[0], $lte: dates.at(-1) } }).lean(),
  ]);
  const byEmp = new Map();
  for (const r of records) {
    const k = String(r.employee);
    if (!byEmp.has(k)) byEmp.set(k, new Map());
    byEmp.get(k).set(r.date, r);
  }
  return {
    period,
    dates,
    rows: employees.map((e) => {
      const map = byEmp.get(String(e._id)) || new Map();
      return {
        employee: { _id: e._id, employeeCode: e.employeeCode, name: e.user?.name, designation: e.designation },
        days: dates.map((d) => (map.has(d) ? codeOf(map.get(d)) : '')),
        totals: totalsOf([...map.values()]),
      };
    }),
  };
}

export async function registerXlsx(ctx, q) {
  const reg = await register(ctx, q);
  const dayCols = reg.dates.map((d) => ({ header: d.slice(8), key: `d${d.slice(8)}`, width: 4.5 }));
  return workbookBuffer([
    {
      name: `Attendance ${reg.period}`,
      columns: [
        { header: 'Code', key: 'code', width: 10 },
        { header: 'Name', key: 'name', width: 24 },
        { header: 'Designation', key: 'designation', width: 16 },
        ...dayCols,
        { header: 'Present', key: 'present', width: 8 },
        { header: 'Late', key: 'late', width: 6 },
        { header: 'Half day', key: 'halfDay', width: 8 },
        { header: 'Absent', key: 'absent', width: 8 },
        { header: 'Paid leave', key: 'paidLeave', width: 10 },
        { header: 'LOP leave', key: 'unpaidLeave', width: 10 },
        { header: 'Week off', key: 'weekOff', width: 9 },
        { header: 'Late mins', key: 'lateMinutes', width: 9 },
      ],
      rows: [
        ...reg.rows.map((r) => ({
          code: r.employee.employeeCode,
          name: r.employee.name,
          designation: r.employee.designation,
          ...Object.fromEntries(r.days.map((c, i) => [`d${reg.dates[i].slice(8)}`, c])),
          ...r.totals,
        })),
        {},
        { code: 'Legend', name: 'P present · L late · H half day · A absent · LV leave · HL half-day leave · LOP unpaid leave · WO week off · HO holiday' },
      ],
    },
  ]);
}

// ---------------------------------------------------------------- absence job

// For yesterday: rostered employees with no attendance are marked absent; scheduled days off become week_off.
export async function markAbsences(now = new Date()) {
  const date = addDaysStr(today(now), -1);
  const societies = await Society.find({ active: true }).select('_id').lean();
  let absent = 0;
  let weekOff = 0;
  for (const s of societies) {
    // eslint-disable-next-line no-await-in-loop
    const employees = await Employee.find({ society: s._id, status: 'active', $or: [{ dateOfJoining: null }, { dateOfJoining: { $lte: date } }] }).select('user weeklyOff defaultShift').lean();
    if (!employees.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const [marked, rc] = await Promise.all([Attendance.find({ society: s._id, date }).select('employee').lean(), rosterContext(s._id, date)]);
    const done = new Set(marked.map((m) => String(m.employee)));
    const docs = [];
    for (const e of employees) {
      if (done.has(String(e._id))) continue;
      const r = resolveShift(e, date, rc.rosterByEmployee, rc.shiftsById);
      docs.push({ society: s._id, employee: e._id, user: e.user, date, status: r.off ? 'week_off' : 'absent', shift: r.shift?._id, shiftStart: r.shift?.start, shiftEnd: r.shift?.end, autoMarked: true });
      if (r.off) weekOff += 1;
      else absent += 1;
    }
    // eslint-disable-next-line no-await-in-loop
    if (docs.length) await Attendance.insertMany(docs, { ordered: false }).catch((err) => { if (err.code !== 11000 && !err.writeErrors) throw err; });
  }
  return { date, absent, weekOff };
}
