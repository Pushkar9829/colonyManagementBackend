import CelebrationSettings from './celebrationSettings.model.js';
import CelebrationWish from './celebrationWish.model.js';
import PersonalDetails from '../people/personalDetails.model.js';
import Household from '../household/household.model.js';
import Membership from '../users/membership.model.js';
import Society from '../society/society.model.js';
import DirectoryProfile from '../directory/directoryProfile.model.js';
import logger from '../../common/utils/logger.js';
import { APP_TIMEZONE, localDateString } from '../../common/utils/dates.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import * as audit from '../audit/audit.service.js';
import { modeOf, sendWhatsApp } from '../whatsapp/whatsapp.service.js';
import { DEFAULT_TEMPLATES, PLACEHOLDERS, render, templateFor, titleFor } from './celebrations.templates.js';

const KINDS = ['birthday', 'anniversary'];
const FIELD = { birthday: 'dateOfBirth', anniversary: 'anniversaryDate' };
const DEFAULTS = { enabled: true, sendTime: '08:00', channels: { whatsapp: true, inapp: true, push: true }, language: 'en', templates: {}, dashboardCard: true };

// ---------- dates (all IST calendar dates, YYYY-MM-DD) ----------
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const localTime = (now) => new Date(now).toLocaleTimeString('en-GB', { timeZone: APP_TIMEZONE, hour12: false }).slice(0, 5);
const dayNumber = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86400000;

// The next time `ymd`'s day and month come round, on or after `today`. 29 Feb is celebrated on 28 Feb
// in non-leap years.
export function nextOccurrence(ymd, today) {
  const at = (year) => `${year}-${ymd.slice(5) === '02-29' && !isLeap(year) ? '02-28' : ymd.slice(5)}`;
  const year = Number(today.slice(0, 4));
  const thisYear = at(year);
  const date = thisYear >= today ? thisYear : at(year + 1);
  return { date, daysAway: dayNumber(date) - dayNumber(today), years: Number(date.slice(0, 4)) - Number(ymd.slice(0, 4)) };
}

// The "MM-DD" keys that fall on `today` (28 Feb also covers 29 Feb birthdays in non-leap years).
function monthDaysFor(today) {
  const md = today.slice(5);
  return md === '02-28' && !isLeap(Number(today.slice(0, 4))) ? ['02-28', '02-29'] : [md];
}

// ---------- people ----------
// Residents with a login who have details, joined with their active membership(s) in that society.
async function residentPeople(filter) {
  const rows = await PersonalDetails.find(filter).lean();
  if (!rows.length) return [];
  const memberships = await Membership.find({ society: { $in: [...new Set(rows.map((r) => String(r.society)))] }, user: { $in: rows.map((r) => r.user) }, status: 'active' })
    .populate('user', 'name phone status notificationPrefs')
    .populate('unit', 'label')
    .lean();
  const byPair = new Map();
  for (const m of memberships) {
    if (!m.user || m.user.status !== 'active') continue;
    const key = `${m.society}:${m.user._id}`;
    const p = byPair.get(key) || { units: [], unitIds: [], user: m.user };
    if (m.unit) { p.units.push(m.unit.label); p.unitIds.push(m.unit._id); }
    byPair.set(key, p);
  }
  return rows
    .filter((r) => byPair.has(`${r.society}:${r.user}`))
    .map((r) => {
      const p = byPair.get(`${r.society}:${r.user}`);
      return {
        society: r.society,
        personKey: `user:${r.user}`,
        subject: 'resident',
        user: r.user,
        name: p.user.name,
        phone: p.user.phone,
        whatsappOk: p.user.notificationPrefs?.whatsapp !== false,
        unit: p.unitIds[0],
        unitLabel: p.units.join(', ') || null,
        dateOfBirth: r.dateOfBirth,
        anniversaryDate: r.anniversaryDate,
      };
    });
}

// Family members without a login (Household.members), optionally only those matching `keep`.
async function familyPeople(filter, keep = () => true) {
  const homes = await Household.find(filter).populate('unit', 'label').lean();
  const out = [];
  for (const h of homes) {
    for (const m of h.members || []) {
      const person = {
        society: h.society,
        personKey: `member:${m._id}`,
        subject: 'family',
        memberId: m._id,
        name: m.name,
        relation: m.relation,
        phone: m.phone,
        whatsappOk: true,
        unit: h.unit?._id || h.unit,
        unitLabel: h.unit?.label || null,
        dateOfBirth: m.dob,
        anniversaryDate: m.anniversaryDate,
        showBirthday: Boolean(m.showBirthday),
      };
      if (keep(person)) out.push(person);
    }
  }
  return out;
}

// ---------- settings ----------
const merge = (doc) => ({
  enabled: doc?.enabled ?? DEFAULTS.enabled,
  sendTime: doc?.sendTime || DEFAULTS.sendTime,
  channels: { ...DEFAULTS.channels, ...(doc?.channels || {}) },
  language: doc?.language || DEFAULTS.language,
  templates: { birthday: doc?.templates?.birthday || '', anniversary: doc?.templates?.anniversary || '' },
  dashboardCard: doc?.dashboardCard ?? DEFAULTS.dashboardCard,
});

export const settingsOf = async (societyId) => merge(await CelebrationSettings.findOne({ society: societyId }).lean());

export async function getSettings(ctx) {
  return { ...(await settingsOf(ctx.societyId)), defaults: DEFAULT_TEMPLATES, placeholders: PLACEHOLDERS, whatsappMode: await modeOf(ctx.societyId) };
}

export async function updateSettings(ctx, data) {
  const set = { updatedBy: ctx.userId };
  const unset = {};
  for (const k of ['enabled', 'sendTime', 'language', 'dashboardCard']) if (data[k] !== undefined) set[k] = data[k];
  for (const [k, v] of Object.entries(data.channels || {})) set[`channels.${k}`] = v;
  for (const [k, v] of Object.entries(data.templates || {})) {
    if (v) set[`templates.${k}`] = v;
    else unset[`templates.${k}`] = 1; // blank = back to the default text
  }
  await CelebrationSettings.updateOne(
    { society: ctx.societyId },
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $setOnInsert: { society: ctx.societyId } },
    { upsert: true },
  );
  audit.record(ctx, 'celebrations.settings_updated', 'CelebrationSettings', undefined, data);
  return getSettings(ctx);
}

export async function preview(ctx, { kind, template, language }) {
  const settings = await settingsOf(ctx.societyId);
  const society = await Society.findById(ctx.societyId).select('name').lean();
  const lang = language || settings.language;
  const text = template || settings.templates[kind] || DEFAULT_TEMPLATES[lang][kind];
  return { title: titleFor({ language: lang }, kind), message: render(text, { name: 'Ravi Iyer', society: society?.name, years: kind === 'birthday' ? 35 : 12 }) };
}

const messageFor = (settings, kind, person, societyName, years) => ({
  title: titleFor(settings, kind),
  message: render(templateFor(settings, kind), { name: person.name, society: societyName, years }),
});

// ---------- admin lists ----------
// Birthdays and anniversaries in the next `days` days (today included), with the prepared wish so
// click-to-chat societies can send it from the list.
export async function upcoming(ctx, { days = 30 }) {
  const today = localDateString();
  const [settings, society, residents, family, mode] = await Promise.all([
    settingsOf(ctx.societyId),
    Society.findById(ctx.societyId).select('name').lean(),
    residentPeople({ society: ctx.societyId, $or: [{ dateOfBirth: { $type: 'string' } }, { anniversaryDate: { $type: 'string' } }] }),
    familyPeople({ society: ctx.societyId }, (p) => p.dateOfBirth || p.anniversaryDate),
    modeOf(ctx.societyId),
  ]);
  const year = Number(today.slice(0, 4));
  const wished = new Set(
    (await CelebrationWish.find({ society: ctx.societyId, year: { $in: [year, year + 1] } }).select('kind personKey year').lean()).map((w) => `${w.kind}:${w.personKey}:${w.year}`),
  );
  const items = [];
  for (const p of [...residents, ...family]) {
    for (const kind of KINDS) {
      const ymd = p[FIELD[kind]];
      if (!ymd) continue;
      const next = nextOccurrence(ymd, today);
      if (next.daysAway > days) continue;
      items.push({
        kind,
        date: next.date,
        daysAway: next.daysAway,
        years: next.years,
        name: p.name,
        subject: p.subject,
        relation: p.relation,
        unit: p.unitLabel,
        phone: p.phone || null,
        wished: wished.has(`${kind}:${p.personKey}:${Number(next.date.slice(0, 4))}`),
        ...messageFor(settings, kind, p, society?.name, next.years),
      });
    }
  }
  items.sort((a, b) => a.daysAway - b.daysAway || a.name.localeCompare(b.name));
  return { items, whatsappMode: mode, days };
}

// The society-wide "Today's birthdays" card: only people who opted in (directory "show birthday" for
// residents, the household toggle for family members). Names and flats only — never dates or ages.
export async function today(ctx) {
  const settings = await settingsOf(ctx.societyId);
  if (!settings.dashboardCard) return { enabled: false, people: [] };
  const mds = monthDaysFor(localDateString());
  const residents = await residentPeople({ society: ctx.societyId, birthMD: { $in: mds } });
  const optedIn = new Set(
    (await DirectoryProfile.find({ society: ctx.societyId, user: { $in: residents.map((r) => r.user) }, showBirthday: true }).select('user').lean()).map((d) => String(d.user)),
  );
  const re = new RegExp(`-(${mds.join('|')})$`);
  const family = await familyPeople({ society: ctx.societyId, 'members.dob': re }, (p) => p.showBirthday && re.test(p.dateOfBirth || ''));
  const people = [...residents.filter((r) => optedIn.has(String(r.user))), ...family]
    .map((p) => ({ name: p.name, unit: p.unitLabel }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { enabled: true, people };
}

// ---------- daily job ----------
async function deliver(societyId, societyName, settings, kind, person, years) {
  const { title, message } = messageFor(settings, kind, person, societyName, years);
  const channels = [];
  const app = ['inapp', ...(settings.channels.push ? ['push'] : [])];
  if (settings.channels.inapp || settings.channels.push) {
    if (person.subject === 'resident') {
      await notifyUsers(societyId, [person.user], { type: 'celebration', title, body: message, link: '/', channels: app });
      channels.push(...app);
    } else if (person.unit) {
      // Family members have no login: their household hears about it instead.
      const residents = await Membership.find({ society: societyId, unit: person.unit, role: 'resident', status: 'active' }).distinct('user');
      await notifyUsers(societyId, residents, { type: 'celebration', title: `${title} — ${person.name}`, body: message, link: '/', channels: app });
      channels.push(...app);
    }
  }
  if (settings.channels.whatsapp && person.phone && person.whatsappOk) {
    channels.push(`whatsapp:${await sendWhatsApp(societyId, person.phone, title, message, { kind: 'wishes' })}`);
  }
  return channels;
}

// Runs every few minutes; each society's wishes go out once its send time has passed (so a server that
// was asleep at 08:00 catches up later in the day). The CelebrationWish unique index claims each wish
// before it is sent, so nobody is wished twice.
export async function sendDueWishes(now = new Date()) {
  const today = localDateString(now);
  const year = Number(today.slice(0, 4));
  const time = localTime(now);
  const mds = monthDaysFor(today);
  const re = new RegExp(`-(${mds.join('|')})$`);
  const matches = (ymd) => typeof ymd === 'string' && re.test(ymd);

  const people = [
    ...(await residentPeople({ $or: [{ birthMD: { $in: mds } }, { anniversaryMD: { $in: mds } }] })),
    ...(await familyPeople({ $or: [{ 'members.dob': re }, { 'members.anniversaryDate': re }] }, (p) => matches(p.dateOfBirth) || matches(p.anniversaryDate))),
  ];
  const bySociety = new Map();
  for (const p of people) {
    const key = String(p.society);
    if (!bySociety.has(key)) bySociety.set(key, []);
    bySociety.get(key).push(p);
  }

  let sent = 0;
  for (const [sid, list] of bySociety) {
    // eslint-disable-next-line no-await-in-loop
    const [settings, society] = await Promise.all([settingsOf(sid), Society.findById(sid).select('name active').lean()]);
    if (!society || society.active === false || !settings.enabled || time < settings.sendTime) continue;
    for (const p of list) {
      for (const kind of KINDS) {
        const ymd = p[FIELD[kind]];
        if (!matches(ymd)) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          const wish = await CelebrationWish.create({ society: society._id, kind, personKey: p.personKey, year, date: today, name: p.name, user: p.user, unit: p.unit });
          // eslint-disable-next-line no-await-in-loop
          const channels = await deliver(society._id, society.name, settings, kind, p, year - Number(ymd.slice(0, 4)));
          // eslint-disable-next-line no-await-in-loop
          await CelebrationWish.updateOne({ _id: wish._id }, { channels });
          sent += 1;
        } catch (err) {
          if (err?.code !== 11000) logger.error({ err, society: sid, kind }, 'celebration wish failed');
        }
      }
    }
  }
  return { sent };
}
