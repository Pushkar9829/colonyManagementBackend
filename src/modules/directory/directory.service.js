import DirectoryProfile from './directoryProfile.model.js';
import Membership from '../users/membership.model.js';
import Block from '../units/block.model.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { monthDay, occupationText, publicOccupation } from '../people/occupation.js';
import { detailsFor } from '../people/people.service.js';

const PROFILE_FIELDS = ['listed', 'showPhone', 'showEmail', 'showProfession', 'showBirthday', 'showOccupation', 'profession', 'skills', 'about'];
const COMMITTEE_ROLES = ['admin', 'accountant'];
const STAFF_ROLES = ['facility_manager', 'guard', 'staff'];

const defaults = () => ({ listed: false, showPhone: false, showEmail: false, showProfession: false, showBirthday: false, showOccupation: false, profession: '', skills: [], about: '' });

function pick(doc) {
  const out = defaults();
  for (const k of PROFILE_FIELDS) if (doc?.[k] !== undefined) out[k] = doc[k];
  return out;
}

export async function getMine(ctx) {
  const doc = await DirectoryProfile.findOne({ society: ctx.societyId, user: ctx.userId }).lean();
  return pick(doc);
}

export async function updateMine(ctx, data) {
  const doc = await DirectoryProfile.findOneAndUpdate(
    { society: ctx.societyId, user: ctx.userId },
    { $set: data, $setOnInsert: { society: ctx.societyId, user: ctx.userId } },
    { upsert: true, returnDocument: 'after', runValidators: true },
  ).lean();
  return pick(doc);
}

// The privacy gate. Every directory response is built here, from an explicit allow-list:
// a field the person hid is never copied into the output (not even as null).
function publicEntry(user, profile, extra, details) {
  const entry = { _id: user._id, name: user.name, ...extra };
  if (profile?.showPhone && user.phone) entry.phone = user.phone;
  if (profile?.showEmail && user.email) entry.email = user.email;
  if (profile?.showProfession) {
    if (profile.profession) entry.profession = profile.profession;
    if (profile.skills?.length) entry.skills = profile.skills;
    if (profile.about) entry.about = profile.about;
  }
  // Day and month only ("MM-DD"): the birth year is never sent.
  if (profile?.showBirthday && details?.dateOfBirth) entry.birthday = monthDay(details.dateOfBirth);
  if (profile?.showOccupation && details?.occupation) entry.occupation = publicOccupation(details.occupation);
  return entry;
}

const shownOccupation = (r) => (r.profile?.showOccupation ? r.details?.occupation : undefined);

// Residents who opted in, with search over the fields they chose to show.
export async function list(ctx, { search, block, occupationType, occupationCategory, institution }, { page, limit, skip }) {
  const profiles = await DirectoryProfile.find({ society: ctx.societyId, listed: true }).lean();
  const byUser = new Map(profiles.map((p) => [String(p.user), p]));
  const memberships = await Membership.find({ society: ctx.societyId, role: 'resident', status: 'active', user: { $in: [...byUser.keys()] } })
    .populate('user', 'name phone email status')
    .populate('unit', 'label block')
    .lean();
  const blocks = new Map((await Block.find({ society: ctx.societyId }).select('name').lean()).map((b) => [String(b._id), b.name]));

  const people = new Map();
  for (const m of memberships) {
    if (!m.user || m.user.status !== 'active') continue;
    const key = String(m.user._id);
    const row = people.get(key) || { user: m.user, profile: byUser.get(key), units: [], blockIds: [], blockNames: [], residentType: m.residentType };
    if (m.unit) {
      row.units.push(m.unit.label);
      row.blockIds.push(String(m.unit.block));
      row.blockNames.push(blocks.get(String(m.unit.block)) || '');
    }
    people.set(key, row);
  }

  let rows = [...people.values()];
  const details = await detailsFor(ctx.societyId, rows.map((r) => r.user._id));
  for (const r of rows) r.details = details.get(String(r.user._id));
  if (block) rows = rows.filter((r) => r.blockIds.includes(String(block)));
  if (occupationType) rows = rows.filter((r) => shownOccupation(r)?.type === occupationType);
  if (occupationCategory) rows = rows.filter((r) => shownOccupation(r)?.type === 'working' && shownOccupation(r).working?.category === occupationCategory);
  if (institution) {
    const re = new RegExp(escapeRegex(institution), 'i');
    rows = rows.filter((r) => shownOccupation(r)?.type === 'student' && re.test(shownOccupation(r).student?.institutionName || ''));
  }
  if (search) {
    const re = new RegExp(escapeRegex(search.trim()), 'i');
    rows = rows.filter((r) => {
      // only fields this person made visible are searchable — otherwise search would leak them
      const haystack = [r.user.name, ...r.units, ...r.blockNames.map((b) => `Block ${b}`)];
      if (r.profile?.showProfession) haystack.push(r.profile.profession || '', ...(r.profile.skills || []));
      haystack.push(...occupationText(shownOccupation(r)));
      return haystack.some((v) => re.test(v));
    });
  }
  rows.sort((a, b) => (a.units[0] || '').localeCompare(b.units[0] || '', undefined, { numeric: true }) || a.user.name.localeCompare(b.user.name));
  const total = rows.length;
  const items = rows.slice(skip, skip + limit).map((r) => publicEntry(r.user, r.profile, { units: r.units, isMe: String(r.user._id) === String(ctx.userId) }, r.details));
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

// Committee and staff: names and designations are public within the society; phone and email
// still follow each person's own directory settings.
export async function contacts(ctx) {
  const memberships = await Membership.find({ society: ctx.societyId, status: 'active', role: { $in: [...COMMITTEE_ROLES, ...STAFF_ROLES] } })
    .populate('user', 'name phone email status')
    .lean();
  const profiles = new Map(
    (await DirectoryProfile.find({ society: ctx.societyId, user: { $in: memberships.map((m) => m.user?._id).filter(Boolean) } }).lean()).map((p) => [String(p.user), p]),
  );
  const committee = [];
  const staff = [];
  const seen = new Set();
  for (const m of memberships) {
    if (!m.user || m.user.status !== 'active') continue;
    const key = `${m.user._id}:${m.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = publicEntry(m.user, profiles.get(String(m.user._id)), { role: m.role, designation: m.designation || null });
    (COMMITTEE_ROLES.includes(m.role) ? committee : staff).push(entry);
  }
  const order = (a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name);
  return { committee: committee.sort(order), staff: staff.sort(order) };
}
