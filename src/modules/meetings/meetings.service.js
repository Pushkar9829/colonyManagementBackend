import Meeting from './meeting.model.js';
import Membership from '../users/membership.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import { paginate } from '../../common/utils/pagination.js';
import { localDateString } from '../../common/utils/dates.js';
import { nextNumber } from '../counter/counter.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { canManage, committeeMembershipIds, positionsOf, signatories } from '../committee/committee.service.js';
import { dateTimeIST, ensureSpace, heading, keyValues, letterhead, loadSociety, longDate, pdfName, renderPdf, sectionTitle, signatureBlock, table, watermark } from '../committee/pdf.js';

const TYPE_LABEL = { agm: 'Annual General Meeting', sgm: 'Special General Meeting', committee: 'Managing Committee Meeting', other: 'Meeting' };
const DEFAULT_AUDIENCE = { agm: 'owners', sgm: 'owners', committee: 'committee', other: 'all_members' };
const MODE_LABEL = { in_person: 'In person', online: 'Online', proxy: 'By proxy' };

// ---- audience ----

// Memberships invited to a meeting, with display names.
export async function audienceMembers(societyId, audience) {
  const filter = { society: societyId, status: 'active' };
  if (audience.type === 'all_members') filter.role = ROLES.RESIDENT;
  if (audience.type === 'owners') Object.assign(filter, { role: ROLES.RESIDENT, residentType: 'owner' });
  if (audience.type === 'committee') filter._id = { $in: await committeeMembershipIds(societyId) };
  if (audience.type === 'custom') filter._id = { $in: audience.memberships || [] };
  const ms = await Membership.find(filter).populate('user', 'name').populate('unit', 'label').lean();
  return ms
    .filter((m) => m.user)
    .map((m) => ({ _id: m._id, user: m.user._id, name: m.user.name, unitLabel: m.unit?.label, residentType: m.residentType, role: m.role }))
    .sort((a, b) => (a.unitLabel || '').localeCompare(b.unitLabel || '') || a.name.localeCompare(b.name));
}

// Which meetings a non-manager may see: those they are invited to, once the notice is out.
async function viewerFilter(ctx) {
  const or = [{ 'audience.type': 'custom', 'audience.memberships': ctx.user?.membershipId }];
  if (ctx.role === ROLES.RESIDENT) or.push({ 'audience.type': 'all_members' });
  if (ctx.role === ROLES.RESIDENT && ctx.user?.residentType === 'owner') or.push({ 'audience.type': 'owners' });
  if ((await positionsOf(ctx.societyId, ctx.userId)).length) or.push({ 'audience.type': 'committee' });
  return { status: { $ne: 'draft' }, $or: or };
}

// ---- quorum & resolutions ----

export function quorumState(meeting, eligible) {
  const present = meeting.attendance.length;
  const { type, value } = meeting.quorum || { type: 'percent', value: 0 };
  const required = type === 'count' ? value : Math.ceil((eligible * value) / 100);
  const byMode = Object.fromEntries(['in_person', 'online', 'proxy'].map((m) => [m, meeting.attendance.filter((a) => a.mode === m).length]));
  return { eligible, present, required, met: present >= required && present > 0, byMode, rule: type === 'count' ? `${value} members` : `${value}% of members` };
}

// Abstentions do not count towards the votes cast.
export function resolutionResult({ votesFor = 0, votesAgainst = 0, majority = 'simple' }) {
  const cast = votesFor + votesAgainst;
  if (!cast || !votesFor) return 'failed';
  if (majority === 'two_thirds') return votesFor * 3 >= cast * 2 ? 'passed' : 'failed';
  if (majority === 'three_fourths') return votesFor * 4 >= cast * 3 ? 'passed' : 'failed';
  return votesFor > votesAgainst ? 'passed' : 'failed';
}

// ---- loading & presenting ----

async function load(ctx, id, manage) {
  const filter = { _id: id, society: ctx.societyId, ...(manage ? {} : await viewerFilter(ctx)) };
  const meeting = await Meeting.findOne(filter);
  if (!meeting) throw ApiError.notFound('Meeting not found');
  return meeting;
}

async function loadForManager(ctx, id) {
  const meeting = await Meeting.findOne({ _id: id, society: ctx.societyId });
  if (!meeting) throw ApiError.notFound('Meeting not found');
  return meeting;
}

const assertEditable = (meeting) => {
  if (meeting.status === 'cancelled') throw ApiError.conflict('This meeting was cancelled');
  if (meeting.minutes.status === 'approved') throw ApiError.conflict('Minutes are approved; the record can no longer be changed');
};

function present(ctx, doc, { manage, quorum } = {}) {
  const m = doc.toObject ? doc.toObject() : { ...doc };
  const approved = m.minutes?.status === 'approved';
  if (!manage && !approved) {
    // Until minutes are approved, members see the notice and agenda, not the draft record.
    m.agenda = (m.agenda || []).map(({ minutes, ...a }) => a);
    m.resolutions = [];
    m.attendance = [];
    m.minutes = { status: m.minutes?.status };
    m.actionItems = (m.actionItems || []).filter((a) => String(a.ownerUser) === String(ctx.userId));
  }
  if (quorum) m.quorumState = quorum;
  m.canManage = Boolean(manage);
  return m;
}

async function full(ctx, meeting, manage) {
  let quorum;
  if (manage || meeting.minutes.status === 'approved') {
    const invitees = await audienceMembers(ctx.societyId, meeting.audience);
    quorum = quorumState(meeting, invitees.length);
  }
  return present(ctx, meeting, { manage, quorum });
}

// ---- meetings ----

export async function list(ctx, filters, pagination) {
  const manage = await canManage(ctx);
  const filter = { society: ctx.societyId, ...(manage ? {} : await viewerFilter(ctx)) };
  if (filters.type) filter.type = filters.type;
  if (filters.status) filter.status = manage || filters.status !== 'draft' ? filters.status : { $ne: 'draft' };
  const now = new Date();
  if (filters.when === 'upcoming') filter.scheduledAt = { $gte: now };
  if (filters.when === 'past') filter.scheduledAt = { $lt: now };
  const result = await paginate(Meeting, filter, pagination, {
    sort: { scheduledAt: filters.when === 'upcoming' ? 1 : -1 },
    select: 'number title type scheduledAt mode venue status audience.type notice minutes.status minutes.approvedAt agenda._id attendance._id resolutions._id actionItems.status',
  });
  result.items = result.items.map((m) => ({
    ...m,
    agendaCount: m.agenda?.length || 0,
    attendanceCount: manage || m.minutes?.status === 'approved' ? m.attendance?.length || 0 : undefined,
    resolutionCount: manage || m.minutes?.status === 'approved' ? m.resolutions?.length || 0 : undefined,
    openActionItems: manage ? (m.actionItems || []).filter((a) => ['open', 'in_progress'].includes(a.status)).length : undefined,
    agenda: undefined,
    attendance: undefined,
    resolutions: undefined,
    actionItems: undefined,
  }));
  return result;
}

export async function getById(ctx, id) {
  const manage = await canManage(ctx);
  return full(ctx, await load(ctx, id, manage), manage);
}

export async function create(ctx, data) {
  const audience = data.audience || { type: DEFAULT_AUDIENCE[data.type] };
  const meeting = await Meeting.create({
    ...data,
    audience,
    society: ctx.societyId,
    number: await nextNumber(ctx.societyId, 'meeting', 'MTG'),
    createdBy: ctx.userId,
  });
  audit.record(ctx, 'meeting.created', 'Meeting', meeting._id, { title: meeting.title, type: meeting.type });
  return full(ctx, meeting, true);
}

export async function update(ctx, id, { agenda, ...data }) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  const rescheduled = meeting.notice.sentAt
    && ((data.scheduledAt && new Date(data.scheduledAt).getTime() !== meeting.scheduledAt.getTime()) || (data.venue !== undefined && data.venue !== meeting.venue));
  Object.assign(meeting, data);
  if (agenda) {
    // Keep minutes already written for items that survive the edit.
    meeting.agenda = agenda.map((a) => {
      const existing = a._id && meeting.agenda.id(a._id);
      return { ...a, minutes: existing?.minutes || '' };
    });
  }
  await meeting.save();
  if (rescheduled) {
    const invitees = await audienceMembers(ctx.societyId, meeting.audience);
    await notifyUsers(ctx.societyId, invitees.map((i) => i.user), {
      type: 'meeting',
      title: `Rescheduled: ${meeting.title}`,
      body: `Now on ${dateTimeIST(meeting.scheduledAt)}${meeting.venue ? ` at ${meeting.venue}` : ''}`,
      link: `/meetings/${meeting._id}`,
      channels: ['inapp', 'push', 'email'],
    });
  }
  return full(ctx, meeting, true);
}

export async function sendNotice(ctx, id) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  if (meeting.status === 'completed') throw ApiError.conflict('This meeting has already been held');
  if (!meeting.agenda.length) throw ApiError.badRequest('Add at least one agenda item before circulating the notice');
  const invitees = await audienceMembers(ctx.societyId, meeting.audience);
  if (!invitees.length) throw ApiError.badRequest('Nobody is in this meeting\'s audience');
  const agendaText = meeting.agenda.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
  await notifyUsers(ctx.societyId, invitees.map((i) => i.user), {
    type: 'meeting',
    title: `${meeting.notice.sentAt ? 'Reminder' : 'Notice'}: ${TYPE_LABEL[meeting.type]} — ${meeting.title}`,
    body: `${dateTimeIST(meeting.scheduledAt)}${meeting.venue ? `, ${meeting.venue}` : ''}${meeting.onlineLink ? ` (online: ${meeting.onlineLink})` : ''}\n\nAgenda:\n${agendaText}`,
    link: `/meetings/${meeting._id}`,
    channels: ['inapp', 'push', 'email'],
  });
  meeting.status = 'scheduled';
  meeting.notice = { sentAt: new Date(), count: (meeting.notice.count || 0) + 1, recipients: invitees.length };
  await meeting.save();
  audit.record(ctx, 'meeting.notice_sent', 'Meeting', meeting._id, { recipients: invitees.length });
  return full(ctx, meeting, true);
}

export async function cancel(ctx, id, reason) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  if (meeting.status === 'completed') throw ApiError.conflict('A held meeting cannot be cancelled');
  meeting.status = 'cancelled';
  meeting.cancelledReason = reason;
  await meeting.save();
  if (meeting.notice.sentAt) {
    const invitees = await audienceMembers(ctx.societyId, meeting.audience);
    await notifyUsers(ctx.societyId, invitees.map((i) => i.user), {
      type: 'meeting',
      title: `Cancelled: ${meeting.title}`,
      body: reason,
      link: `/meetings/${meeting._id}`,
      channels: ['inapp', 'push', 'email'],
    });
  }
  audit.record(ctx, 'meeting.cancelled', 'Meeting', meeting._id, { reason });
  return full(ctx, meeting, true);
}

export async function invitees(ctx, id) {
  const meeting = await loadForManager(ctx, id);
  const list = await audienceMembers(ctx.societyId, meeting.audience);
  const marked = new Map(meeting.attendance.map((a) => [String(a.membership), a]));
  return list.map((i) => ({ ...i, attendance: marked.get(String(i._id)) || null }));
}

// ---- agenda & minutes ----

export async function addAgendaItem(ctx, id, data) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  meeting.agenda.push(data);
  await meeting.save();
  return full(ctx, meeting, true);
}

export async function updateAgendaItem(ctx, id, itemId, data) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  const item = meeting.agenda.id(itemId);
  if (!item) throw ApiError.notFound('Agenda item not found');
  Object.assign(item, data);
  await meeting.save();
  return full(ctx, meeting, true);
}

export async function removeAgendaItem(ctx, id, itemId) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  const item = meeting.agenda.id(itemId);
  if (!item) throw ApiError.notFound('Agenda item not found');
  if (meeting.resolutions.some((r) => String(r.agendaItem) === String(itemId))) throw ApiError.conflict('Resolutions are recorded against this item');
  item.deleteOne();
  await meeting.save();
  return full(ctx, meeting, true);
}

export async function updateMinutes(ctx, id, { summary }) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  meeting.minutes.summary = summary;
  await meeting.save();
  return full(ctx, meeting, true);
}

export async function approveMinutes(ctx, id) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  if (meeting.status === 'draft') throw ApiError.conflict('Circulate the notice and hold the meeting first');
  if (meeting.scheduledAt > new Date()) throw ApiError.conflict('Minutes can be approved only after the meeting has taken place');
  meeting.minutes.status = 'approved';
  meeting.minutes.approvedBy = ctx.userId;
  meeting.minutes.approvedAt = new Date();
  meeting.minutes.signatories = await signatories(ctx.societyId);
  meeting.status = 'completed';
  await meeting.save();
  const list = await audienceMembers(ctx.societyId, meeting.audience);
  await notifyUsers(ctx.societyId, list.map((i) => i.user).filter((u) => String(u) !== String(ctx.userId)), {
    type: 'meeting',
    title: `Minutes approved: ${meeting.title}`,
    body: `${meeting.resolutions.length} resolution(s) recorded. Download the minutes from the meeting page.`,
    link: `/meetings/${meeting._id}`,
  });
  audit.record(ctx, 'meeting.minutes_approved', 'Meeting', meeting._id);
  return full(ctx, meeting, true);
}

// ---- attendance ----

export async function markAttendance(ctx, id, { entries }) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  if (meeting.status === 'draft') throw ApiError.conflict('Circulate the notice before taking attendance');
  const list = await audienceMembers(ctx.societyId, meeting.audience);
  const byId = new Map(list.map((i) => [String(i._id), i]));
  for (const e of entries) {
    const invitee = byId.get(String(e.membership));
    if (!invitee) throw ApiError.badRequest('Only invited members can be marked present');
    if (e.mode === 'proxy' && !e.proxyHolder) throw ApiError.badRequest(`Name the proxy holder for ${invitee.name}`);
    const existing = meeting.attendance.find((a) => String(a.membership) === String(e.membership));
    const row = { membership: invitee._id, user: invitee.user, name: invitee.name, unitLabel: invitee.unitLabel, mode: e.mode, proxyHolder: e.mode === 'proxy' ? e.proxyHolder : undefined, markedBy: ctx.userId };
    if (existing) Object.assign(existing, row);
    else meeting.attendance.push(row);
  }
  await meeting.save();
  return full(ctx, meeting, true);
}

export async function removeAttendance(ctx, id, membershipId) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  const row = meeting.attendance.find((a) => String(a.membership) === String(membershipId));
  if (!row) throw ApiError.notFound('Not marked present');
  row.deleteOne();
  await meeting.save();
  return full(ctx, meeting, true);
}

// ---- resolutions ----

function validateResolution(meeting, data, invitees) {
  const quorum = quorumState(meeting, invitees.length);
  if (!quorum.met) throw ApiError.conflict(`Quorum not met (${quorum.present} present, ${quorum.required} required); resolutions cannot be passed`);
  const presentIds = new Set(meeting.attendance.map((a) => String(a.membership)));
  const nameOf = (mid) => meeting.attendance.find((a) => String(a.membership) === String(mid))?.name;
  if (data.proposedBy && !presentIds.has(String(data.proposedBy))) throw ApiError.badRequest('The proposer must be present at the meeting');
  if (data.secondedBy && !presentIds.has(String(data.secondedBy))) throw ApiError.badRequest('The seconder must be present at the meeting');
  if (data.proposedBy && data.secondedBy && String(data.proposedBy) === String(data.secondedBy)) throw ApiError.badRequest('Proposer and seconder must be different members');
  const total = (data.votesFor || 0) + (data.votesAgainst || 0) + (data.abstain || 0);
  if (total > quorum.present) throw ApiError.badRequest(`Votes (${total}) exceed members present (${quorum.present})`);
  if (data.agendaItem && !meeting.agenda.id(data.agendaItem)) throw ApiError.badRequest('Unknown agenda item');
  return {
    proposedByName: data.proposedBy ? nameOf(data.proposedBy) : undefined,
    secondedByName: data.secondedBy ? nameOf(data.secondedBy) : undefined,
    result: resolutionResult(data),
  };
}

export async function addResolution(ctx, id, data) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  if (meeting.status === 'draft') throw ApiError.conflict('The meeting has not been convened');
  const derived = validateResolution(meeting, data, await audienceMembers(ctx.societyId, meeting.audience));
  meeting.resolutions.push({ ...data, ...derived, number: `R-${meeting.resolutions.length + 1}`, recordedBy: ctx.userId });
  await meeting.save();
  audit.record(ctx, 'meeting.resolution_recorded', 'Meeting', meeting._id, { title: data.title, result: derived.result });
  return full(ctx, meeting, true);
}

export async function updateResolution(ctx, id, resolutionId, data) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  const r = meeting.resolutions.id(resolutionId);
  if (!r) throw ApiError.notFound('Resolution not found');
  const merged = { ...r.toObject(), ...data };
  const derived = validateResolution(meeting, merged, await audienceMembers(ctx.societyId, meeting.audience));
  Object.assign(r, data, derived);
  await meeting.save();
  return full(ctx, meeting, true);
}

export async function removeResolution(ctx, id, resolutionId) {
  const meeting = await loadForManager(ctx, id);
  assertEditable(meeting);
  const r = meeting.resolutions.id(resolutionId);
  if (!r) throw ApiError.notFound('Resolution not found');
  r.deleteOne();
  meeting.resolutions.forEach((x, i) => { x.number = `R-${i + 1}`; });
  await meeting.save();
  return full(ctx, meeting, true);
}

// ---- action items ----

async function ownerFor(ctx, membershipId) {
  const m = await Membership.findOne({ _id: membershipId, society: ctx.societyId, status: 'active' }).populate('user', 'name').lean();
  if (!m?.user) throw ApiError.badRequest('Action item owner must be an active member');
  return { owner: m._id, ownerUser: m.user._id, ownerName: m.user.name };
}

export async function addActionItem(ctx, id, data) {
  const meeting = await loadForManager(ctx, id);
  if (meeting.status === 'cancelled') throw ApiError.conflict('This meeting was cancelled');
  if (data.agendaItem && !meeting.agenda.id(data.agendaItem)) throw ApiError.badRequest('Unknown agenda item');
  const owner = data.owner ? await ownerFor(ctx, data.owner) : {};
  meeting.actionItems.push({ ...data, ...owner });
  await meeting.save();
  if (owner.ownerUser) {
    await notifyUsers(ctx.societyId, [owner.ownerUser], {
      type: 'meeting',
      title: 'Action item assigned to you',
      body: `${data.title}${data.dueDate ? ` — due ${longDate(data.dueDate)}` : ''} (${meeting.title})`,
      link: `/meetings/${meeting._id}`,
    });
  }
  return full(ctx, meeting, true);
}

// Managers edit everything; the owner may update the status and notes of their own item.
export async function updateActionItem(ctx, id, itemId, data) {
  const manage = await canManage(ctx);
  const meeting = await Meeting.findOne({ _id: id, society: ctx.societyId });
  const item = meeting?.actionItems.id(itemId);
  if (!item || (!manage && String(item.ownerUser) !== String(ctx.userId))) throw ApiError.notFound('Action item not found');
  const allowed = manage ? data : { status: data.status, notes: data.notes };
  if (!manage && Object.keys(data).some((k) => !['status', 'notes'].includes(k))) throw ApiError.forbidden('You can only update the status and notes of your action item');
  if (allowed.owner) Object.assign(allowed, await ownerFor(ctx, allowed.owner));
  for (const [k, v] of Object.entries(allowed)) if (v !== undefined) item[k] = v;
  if (item.status === 'done' && !item.completedAt) item.completedAt = new Date();
  if (item.status !== 'done') item.completedAt = undefined;
  await meeting.save();
  return full(ctx, meeting, manage);
}

export async function removeActionItem(ctx, id, itemId) {
  const meeting = await loadForManager(ctx, id);
  const item = meeting.actionItems.id(itemId);
  if (!item) throw ApiError.notFound('Action item not found');
  item.deleteOne();
  await meeting.save();
  return full(ctx, meeting, true);
}

// Action items across meetings (a tracker). Members see only their own.
export async function listActionItems(ctx, filters) {
  const manage = await canManage(ctx);
  const onlyMine = !manage || filters.mine;
  const filter = { society: ctx.societyId, status: { $ne: 'cancelled' }, 'actionItems.0': { $exists: true } };
  if (onlyMine) filter['actionItems.ownerUser'] = ctx.userId;
  const meetings = await Meeting.find(filter).select('number title type scheduledAt actionItems').lean();
  const today = localDateString();
  const rows = [];
  for (const m of meetings) {
    for (const a of m.actionItems) {
      const isOverdue = ['open', 'in_progress'].includes(a.status) && Boolean(a.dueDate) && a.dueDate < today;
      if (onlyMine && String(a.ownerUser) !== String(ctx.userId)) continue;
      if (filters.status && a.status !== filters.status) continue;
      if (filters.overdue && !isOverdue) continue;
      rows.push({ ...a, isOverdue, meeting: { _id: m._id, number: m.number, title: m.title, type: m.type, scheduledAt: m.scheduledAt } });
    }
  }
  const rank = { open: 0, in_progress: 1, done: 2, cancelled: 3 };
  return rows.sort((a, b) => rank[a.status] - rank[b.status] || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
}

// ---- attachments ----

export async function addAttachments(ctx, id, ids) {
  const meeting = await loadForManager(ctx, id);
  if (meeting.status === 'cancelled') throw ApiError.conflict('This meeting was cancelled');
  meeting.attachments.push(...(await uploads.resolve(ctx, ids)));
  if (meeting.attachments.length > 20) throw ApiError.badRequest('A meeting can hold up to 20 attachments');
  await meeting.save();
  return full(ctx, meeting, true);
}

export async function removeAttachment(ctx, id, attachmentId) {
  const meeting = await loadForManager(ctx, id);
  const a = meeting.attachments.id(attachmentId);
  if (!a) throw ApiError.notFound('Attachment not found');
  a.deleteOne();
  await meeting.save();
  return full(ctx, meeting, true);
}

// ---- minutes PDF ----

export async function minutesPdf(ctx, id) {
  const manage = await canManage(ctx);
  const meeting = (await load(ctx, id, manage)).toObject();
  const approved = meeting.minutes.status === 'approved';
  if (!manage && !approved) throw ApiError.forbidden('Minutes will be available once approved');
  const [society, invitees] = await Promise.all([loadSociety(ctx.societyId), audienceMembers(ctx.societyId, meeting.audience)]);
  const quorum = quorumState(meeting, invitees.length);
  const signers = approved ? meeting.minutes.signatories : await signatories(ctx.societyId);

  const buffer = await renderPdf((doc) => {
    letterhead(doc, society);
    heading(doc, `Minutes of the ${TYPE_LABEL[meeting.type]}`);
    doc.font('Helvetica-Bold').fontSize(11).text(meeting.title, { align: 'center' });
    doc.moveDown(0.8);
    doc.font('Helvetica').fontSize(10);
    keyValues(doc, [
      ['Meeting no.', meeting.number],
      ['Date & time', dateTimeIST(meeting.scheduledAt)],
      ['Venue', meeting.venue],
      ['Mode', meeting.mode === 'hybrid' ? 'In person and online' : meeting.mode === 'online' ? 'Online' : 'In person'],
      ['Notice circulated', meeting.notice?.sentAt ? `${dateTimeIST(meeting.notice.sentAt)} to ${meeting.notice.recipients} member(s)` : 'Not recorded'],
      ['Quorum', `${quorum.rule} — ${quorum.required} required, ${quorum.present} present (${quorum.byMode.in_person} in person, ${quorum.byMode.online} online, ${quorum.byMode.proxy} by proxy). Quorum ${quorum.met ? 'was present' : 'was NOT present'}.`],
    ]);

    sectionTitle(doc, `Members present (${meeting.attendance.length})`);
    if (meeting.attendance.length) {
      table(doc, [
        { header: '#', width: 0.06, render: (r) => r.i },
        { header: 'Member', width: 0.36, key: 'name' },
        { header: 'Unit', width: 0.14, key: 'unitLabel' },
        { header: 'Attendance', width: 0.44, render: (r) => (r.mode === 'proxy' ? `By proxy — ${r.proxyHolder}` : MODE_LABEL[r.mode]) },
      ], meeting.attendance.map((a, i) => ({ ...a, i: i + 1 })));
    } else doc.text('No attendance recorded.');

    if (meeting.minutes.summary) {
      sectionTitle(doc, 'Proceedings');
      doc.text(meeting.minutes.summary, { align: 'justify' });
    }

    const resolutionText = (r) => {
      ensureSpace(doc, 80);
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(10).text(`Resolution ${r.number}: ${r.title}`);
      doc.font('Helvetica-Oblique').text(r.text, { align: 'justify' });
      doc.font('Helvetica').fontSize(9.5).fillColor('#334155')
        .text(`Proposed by: ${r.proposedByName || '—'}    Seconded by: ${r.secondedByName || '—'}`)
        .text(`Votes — For: ${r.votesFor}, Against: ${r.votesAgainst}, Abstained: ${r.abstain} (${r.majority.replace('_', ' ')} majority required). Resolution ${r.result.toUpperCase()}.`);
      doc.fillColor('#0f172a').fontSize(10);
    };

    sectionTitle(doc, 'Agenda and minutes');
    meeting.agenda.forEach((a, i) => {
      ensureSpace(doc, 60);
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(10.5).text(`Item ${i + 1}. ${a.title}`);
      doc.font('Helvetica').fontSize(10);
      if (a.presenter) doc.fillColor('#475569').text(`Presented by ${a.presenter}`).fillColor('#0f172a');
      doc.text(a.minutes || 'No minutes recorded for this item.', { align: 'justify' });
      meeting.resolutions.filter((r) => String(r.agendaItem) === String(a._id)).forEach(resolutionText);
    });
    const other = meeting.resolutions.filter((r) => !r.agendaItem || !meeting.agenda.some((a) => String(a._id) === String(r.agendaItem)));
    if (other.length) {
      sectionTitle(doc, 'Other resolutions');
      other.forEach(resolutionText);
    }

    if (meeting.actionItems.length) {
      sectionTitle(doc, 'Action items');
      table(doc, [
        { header: 'Action', width: 0.46, key: 'title' },
        { header: 'Owner', width: 0.22, render: (r) => r.ownerName || '—' },
        { header: 'Due', width: 0.16, render: (r) => (r.dueDate ? longDate(r.dueDate) : '—') },
        { header: 'Status', width: 0.16, render: (r) => r.status.replace('_', ' ') },
      ], meeting.actionItems);
    }

    if (approved) {
      doc.moveDown(0.5);
      doc.fontSize(9).fillColor('#475569').text(`Minutes approved on ${dateTimeIST(meeting.minutes.approvedAt)}.`).fillColor('#0f172a');
    }
    signatureBlock(doc, signers, { label: 'Confirmed and signed' });
    if (!approved) watermark(doc, 'DRAFT');
  });
  return { buffer, filename: pdfName(`Minutes-${meeting.number}`) };
}
