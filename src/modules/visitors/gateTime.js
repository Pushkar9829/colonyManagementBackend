import { APP_TIMEZONE, toMinutes } from '../../common/utils/dates.js';

// Wall-clock parts of an instant in the society timezone (IST). Recurring passes, patrol windows and
// EV slots are all defined as local "HH:MM" times, so they are evaluated here rather than in server time.
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIMEZONE,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(date = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, dow: DOW[p.weekday], minutes: Number(p.hour) * 60 + Number(p.minute) };
}

// "YYYY-MM-DD" + "HH:MM" (IST) -> Date
export const localDateTime = (dateStr, hhmm) => new Date(`${dateStr}T${hhmm}:00+05:30`);

// True when `date` falls on one of `days` (0 = Sunday) between start and end, local time, end exclusive.
export function inWeeklyWindow(date, { days, startTime, endTime }) {
  const { dow, minutes } = localParts(date);
  if (days?.length && !days.includes(dow)) return false;
  return minutes >= toMinutes(startTime) && minutes < toMinutes(endTime);
}

export const normalizePlate = (v) => (v ? String(v).replace(/[^a-z0-9]/gi, '').toUpperCase() : '');
// Last 10 digits, so "+91 98111 11111" and "9811111111" match.
export const normalizePhone = (v) => (v ? String(v).replace(/\D/g, '').slice(-10) : '');

// Client-supplied event time (offline queue, devices). Rejects clocks that are clearly wrong.
const MAX_PAST_MS = 7 * 86400 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
export function eventTime(occurredAt, now = new Date()) {
  if (!occurredAt) return now;
  const t = new Date(occurredAt);
  if (Number.isNaN(t.getTime())) return now;
  if (t.getTime() > now.getTime() + MAX_FUTURE_MS) return now;
  if (t.getTime() < now.getTime() - MAX_PAST_MS) return null;
  return t > now ? now : t;
}
