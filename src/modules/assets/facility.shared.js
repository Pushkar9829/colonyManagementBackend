import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import { localDateString } from '../../common/utils/dates.js';
import { ROLES } from '../../common/constants/index.js';
import ApiError from '../../common/errors/ApiError.js';
import Membership from '../users/membership.model.js';

// Helpers shared by the facility modules (assets, maintenance, inventory, utilityLogs, staffhr).

export const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

export const FACILITY_MANAGERS = [ROLES.ADMIN, ROLES.FACILITY_MANAGER];
export const isManagerRole = (role) => FACILITY_MANAGERS.includes(role);

// Scheduler jobs act as the society admin without a human actor.
export const systemCtx = (societyId) => ({ societyId, userId: null, role: ROLES.ADMIN, unitId: null, ip: 'scheduler' });

// ---- calendar-date arithmetic on 'YYYY-MM-DD' strings (UTC math so DST/offsets never shift a day) ----
const utc = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);

export const today = (now = new Date()) => localDateString(now);
export const addDaysStr = (s, n) => iso(new Date(utc(s).getTime() + n * 86400000));
export const diffDays = (from, to) => Math.round((utc(to) - utc(from)) / 86400000);
export const weekday = (s) => utc(s).getUTCDay(); // 0 = Sunday

// Adds calendar months, clamping to the last day (Jan 31 + 1 month = Feb 28/29).
export function addMonthsStr(s, months) {
  const d = utc(s);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return iso(target);
}

export const daysInPeriod = (period) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
export const periodDates = (period) => Array.from({ length: daysInPeriod(period) }, (_, i) => `${period}-${String(i + 1).padStart(2, '0')}`);

export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDaysStr(d, 1)) out.push(d);
  return out;
}

// Absolute instant of an IST wall-clock time on a calendar date.
export const istInstant = (dateStr, hhmm = '00:00') => new Date(`${dateStr}T${hhmm}:00+05:30`);

// Distance between two GPS points in metres (haversine).
export function distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

// Builds an .xlsx from [{ name, columns: [{ header, key, width }], rows }] and returns a Buffer.
export async function workbookBuffer(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ColonyHub';
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    ws.columns = s.columns.map((c) => ({ width: 16, ...c }));
    ws.getRow(1).font = { bold: true };
    ws.addRows(s.rows);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function sendFile(res, buffer, filename, type) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buffer);
}

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const sendXlsx = (res, buffer, filename) => sendFile(res, buffer, filename, XLSX);

// Alert thresholds (days before expiry) for AMC / warranty / NOC / extinguisher reminders.
export const EXPIRY_ALERT_DAYS = [30, 7, 1];

// Work visible to a non-manager: assigned to them, or unassigned and meant for their role.
export const assignedFilter = (ctx) =>
  isManagerRole(ctx.role) ? {} : { $or: [{ assignee: ctx.userId }, { assignee: null, assigneeRole: ctx.role }] };

export const canWorkOn = (ctx, doc) =>
  isManagerRole(ctx.role) || String(doc.assignee || '') === String(ctx.userId) || (!doc.assignee && doc.assigneeRole === ctx.role);

// Checks a user id is an active member of this society holding one of the roles.
export async function assertMember(ctx, userId, roles = [ROLES.STAFF, ROLES.FACILITY_MANAGER, ROLES.GUARD, ROLES.ADMIN], what = 'Assignee') {
  if (!userId) return null;
  const m = await Membership.findOne({ user: userId, society: ctx.societyId, role: { $in: roles }, status: 'active' }).select('user role').lean();
  if (!m) throw ApiError.badRequest(`${what} must be an active ${roles.map((r) => r.replace('_', ' ')).join(' / ')} of this society`);
  return m;
}
