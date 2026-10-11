import ServiceRequest from './serviceRequest.model.js';
import Bill from '../billing/bill.model.js';
import Unit from '../units/unit.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import { paginate } from '../../common/utils/pagination.js';
import { localDateString } from '../../common/utils/dates.js';
import { money } from '../../common/utils/money.js';
import { nextNumber } from '../counter/counter.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import { canManage, managerUserIds, signatories } from '../committee/committee.service.js';
import { heading, letterhead, loadSociety, longDate, pdfName, renderPdf, signatureBlock } from '../committee/pdf.js';
import { defaultLetter } from './letters.js';

const OPEN = ['pending', 'info_requested'];
const KIND_LABEL = { noc: 'NOC', move_in: 'Move-in', move_out: 'Move-out' };
const NOC_LABEL = { sale: 'sale', passport: 'passport / visa', bank_loan: 'bank loan', electricity: 'electricity', gas: 'gas', renovation: 'renovation', other: 'general' };
const isMove = (r) => r.kind === 'move_in' || r.kind === 'move_out';
const titleOf = (r) => (r.kind === 'noc' ? `${NOC_LABEL[r.nocType]} NOC` : `${KIND_LABEL[r.kind]} on ${r.move?.date}`);

// Outstanding maintenance for the unit, so the committee can hold a NOC until dues are cleared.
export async function unitDues(societyId, unitId) {
  const bills = await Bill.find({ society: societyId, unit: unitId, status: { $in: ['unpaid', 'partial'] } })
    .select('billNumber period total paid dueDate status')
    .sort({ period: 1 })
    .lean();
  const rows = bills.map((b) => ({ _id: b._id, billNumber: b.billNumber, period: b.period, status: b.status, dueDate: b.dueDate, balance: Math.max(0, b.total - b.paid) }));
  return { outstanding: rows.reduce((s, b) => s + b.balance, 0), bills: rows };
}

async function scope(ctx, manage) {
  return manage ? { society: ctx.societyId } : { society: ctx.societyId, raisedBy: ctx.userId };
}

async function load(ctx, id, manage) {
  const r = await ServiceRequest.findOne({ ...(await scope(ctx, manage)), _id: id });
  if (!r) throw ApiError.notFound('Request not found');
  return r;
}

async function present(ctx, doc, manage, { withDues } = {}) {
  const r = doc.toObject ? doc.toObject() : { ...doc };
  if (!manage) r.comments = (r.comments || []).filter((c) => !c.internal);
  if (withDues && manage) r.dues = await unitDues(ctx.societyId, r.unit?._id || r.unit);
  r.canManage = manage;
  r.hasLetter = r.status === 'approved' && Boolean(r.letter?.number);
  return r;
}

const POPULATE = [{ path: 'raisedBy', select: 'name phone' }, { path: 'comments.by', select: 'name' }, { path: 'history.by', select: 'name' }, { path: 'decidedBy', select: 'name' }];

async function reload(ctx, id, manage) {
  return present(ctx, await ServiceRequest.findById(id).populate(POPULATE).lean(), manage, { withDues: true });
}

function transition(r, by, to, note) {
  r.history.push({ by, from: r.status, to, note });
  r.status = to;
}

// ---- resident actions ----

export async function create(ctx, data) {
  if (ctx.role !== ROLES.RESIDENT || !ctx.unitId) throw ApiError.forbidden('Requests are raised from your home. Switch to your flat first.');
  const unit = await Unit.findOne({ _id: ctx.unitId, society: ctx.societyId }).select('label').lean();
  const residentType = ctx.user?.residentType;
  const attachments = await uploads.resolve(ctx, data.attachments);

  if (isMove(data)) {
    if (data.move.date < localDateString()) throw ApiError.badRequest('The move date cannot be in the past');
    if (data.move.to <= data.move.from) throw ApiError.badRequest('The time slot must end after it starts');
    data.move.tenancy = data.move.tenancy || (residentType === 'tenant' ? 'tenant' : 'owner');
    if (data.kind === 'move_in' && data.move.tenancy === 'tenant' && !attachments.length) {
      throw ApiError.badRequest('Attach the registered rent / leave-and-licence agreement for a tenant move-in');
    }
  }
  if (data.kind === 'noc' && data.nocType === 'sale' && residentType !== 'owner') throw ApiError.forbidden('Only the owner can request a sale NOC');

  const request = await ServiceRequest.create({
    ...data,
    attachments,
    society: ctx.societyId,
    number: await nextNumber(ctx.societyId, 'service-request', 'REQ'),
    unit: ctx.unitId,
    unitLabel: unit?.label,
    raisedBy: ctx.userId,
    applicantName: ctx.user?.name,
    residentType,
    history: [{ by: ctx.userId, to: 'pending' }],
  });
  await notifyUsers(ctx.societyId, await managerUserIds(ctx.societyId), {
    type: 'request',
    title: `New ${titleOf(request)} request ${request.number}`,
    body: `${request.applicantName} (${request.unitLabel})`,
    link: `/requests/${request._id}`,
  });
  return reload(ctx, request._id, false);
}

export async function respond(ctx, id, { text, attachments: ids }) {
  const r = await load(ctx, id, false);
  if (r.status !== 'info_requested') throw ApiError.conflict('No information was requested on this request');
  const attachments = await uploads.resolve(ctx, ids);
  r.comments.push({ by: ctx.userId, text, attachments });
  r.attachments.push(...attachments);
  transition(r, ctx.userId, 'pending', 'Information provided');
  await r.save();
  await notifyUsers(ctx.societyId, await managerUserIds(ctx.societyId), { type: 'request', title: `${r.number}: information provided`, body: text.slice(0, 140), link: `/requests/${r._id}` });
  return reload(ctx, r._id, false);
}

export async function cancel(ctx, id) {
  const r = await load(ctx, id, false);
  if (!OPEN.includes(r.status)) throw ApiError.conflict('Only open requests can be withdrawn');
  transition(r, ctx.userId, 'cancelled', 'Withdrawn by resident');
  await r.save();
  return reload(ctx, r._id, false);
}

// ---- shared ----

export async function list(ctx, filters, pagination) {
  const manage = await canManage(ctx);
  const filter = await scope(ctx, manage && !filters.mine);
  for (const k of ['kind', 'status', 'nocType']) if (filters[k]) filter[k] = filters[k];
  if (filters.open) filter.status = { $in: OPEN };
  const result = await paginate(ServiceRequest, filter, pagination, { select: '-comments -history -letter.body', populate: { path: 'raisedBy', select: 'name' } });
  result.items = await Promise.all(result.items.map((r) => present(ctx, r, manage)));
  return result;
}

export async function getById(ctx, id) {
  const manage = await canManage(ctx);
  await load(ctx, id, manage);
  return reload(ctx, id, manage);
}

export async function addComment(ctx, id, { text, internal, attachments: ids }) {
  const manage = await canManage(ctx);
  const r = await load(ctx, id, manage);
  if (['cancelled'].includes(r.status)) throw ApiError.conflict('This request was withdrawn');
  const attachments = await uploads.resolve(ctx, ids);
  const isInternal = Boolean(internal) && manage;
  r.comments.push({ by: ctx.userId, text, internal: isInternal, attachments });
  await r.save();
  if (!isInternal) {
    const own = String(r.raisedBy) === String(ctx.userId);
    const recipients = own ? await managerUserIds(ctx.societyId) : [r.raisedBy];
    await notifyUsers(ctx.societyId, recipients.filter((u) => String(u) !== String(ctx.userId)), { type: 'request', title: `New comment on ${r.number}`, body: text.slice(0, 140), link: `/requests/${r._id}` });
  }
  return reload(ctx, r._id, manage);
}

// ---- committee actions ----

export async function requestInfo(ctx, id, { note }) {
  const r = await load(ctx, id, true);
  if (r.status !== 'pending') throw ApiError.conflict('Information can be requested only on a pending request');
  r.comments.push({ by: ctx.userId, text: note });
  transition(r, ctx.userId, 'info_requested', note);
  await r.save();
  await notifyUsers(ctx.societyId, [r.raisedBy], { type: 'request', title: `${r.number}: more information needed`, body: note, link: `/requests/${r._id}` });
  return reload(ctx, r._id, true);
}

export async function approve(ctx, id, { note, fees, acknowledgeDues, subject, letterBody }) {
  const r = await load(ctx, id, true);
  if (!OPEN.includes(r.status)) throw ApiError.conflict(`This request is already ${r.status}`);
  const dues = await unitDues(ctx.societyId, r.unit);
  if (r.kind === 'noc' && dues.outstanding > 0 && !acknowledgeDues) {
    throw new ApiError(409, 'DUES_OUTSTANDING', `${r.unitLabel} has ${money(dues.outstanding)} outstanding. Confirm to approve the NOC anyway.`, { outstanding: dues.outstanding });
  }
  const society = await loadSociety(ctx.societyId);
  const template = defaultLetter(r.toObject(), society);
  const [signatory] = await signatories(ctx.societyId);
  r.letter = {
    number: await nextNumber(ctx.societyId, 'request-letter', 'LTR'),
    issuedAt: new Date(),
    subject: subject || template.subject,
    body: letterBody || template.body,
    signatory: signatory || { name: '', position: 'Hon. Secretary' },
  };
  if (fees !== undefined) r.fees = fees;
  r.decidedBy = ctx.userId;
  r.decidedAt = new Date();
  r.decisionNote = note;
  r.duesAtApproval = dues.outstanding;
  transition(r, ctx.userId, 'approved', note);
  await r.save();
  audit.record(ctx, 'request.approved', 'ServiceRequest', r._id, { number: r.number, kind: r.kind, nocType: r.nocType, duesOutstanding: dues.outstanding });

  await notifyUsers(ctx.societyId, [r.raisedBy], {
    type: 'request',
    title: `${r.number} approved`,
    body: `Your ${titleOf(r)} request is approved. Download the letter from the request page.${r.fees ? ` Fees: ${r.fees}` : ''}`,
    link: `/requests/${r._id}`,
    channels: ['inapp', 'push', 'email'],
  });
  if (isMove(r)) {
    await notifyRoles(ctx.societyId, [ROLES.GUARD], {
      type: 'request',
      title: `${KIND_LABEL[r.kind]} approved: ${r.unitLabel} on ${longDate(r.move.date)}`,
      body: moveSummary(r),
      link: '/requests',
    });
    invalidate(ctx.societyId, ['requests'], { roles: [ROLES.GUARD] });
  }
  return reload(ctx, r._id, true);
}

export async function reject(ctx, id, { reason }) {
  const r = await load(ctx, id, true);
  if (!OPEN.includes(r.status)) throw ApiError.conflict(`This request is already ${r.status}`);
  r.decidedBy = ctx.userId;
  r.decidedAt = new Date();
  r.decisionNote = reason;
  r.comments.push({ by: ctx.userId, text: `Rejected: ${reason}` });
  transition(r, ctx.userId, 'rejected', reason);
  await r.save();
  audit.record(ctx, 'request.rejected', 'ServiceRequest', r._id, { number: r.number, reason });
  await notifyUsers(ctx.societyId, [r.raisedBy], { type: 'request', title: `${r.number} was not approved`, body: reason, link: `/requests/${r._id}`, channels: ['inapp', 'push', 'email'] });
  return reload(ctx, r._id, true);
}

// ---- guards: who is moving today ----

const moveSummary = (r) => `${r.applicantName}, ${r.move.from}-${r.move.to}${r.move.vehicleNumber ? `, vehicle ${r.move.vehicleNumber}` : ''}${r.move.moversCompany ? `, ${r.move.moversCompany}` : ''}${r.move.liftBooking ? ', lift booked' : ''}`;

export async function moves(ctx, { date }) {
  const day = date || localDateString();
  const rows = await ServiceRequest.find({ society: ctx.societyId, kind: { $in: ['move_in', 'move_out'] }, status: 'approved', 'move.date': day })
    .select('number kind unitLabel applicantName residentType move status')
    .sort({ 'move.from': 1 })
    .lean();
  return { date: day, items: rows };
}

// Scheduler: on the moving day, remind the guards who to let in.
export async function notifyGuardsForToday(now = new Date()) {
  const today = localDateString(now);
  const due = await ServiceRequest.find({ kind: { $in: ['move_in', 'move_out'] }, status: 'approved', 'move.date': today, 'move.guardsNotifiedOn': { $ne: today } })
    .select('society number kind unitLabel applicantName move')
    .lean();
  const bySociety = new Map();
  for (const r of due) bySociety.set(String(r.society), [...(bySociety.get(String(r.society)) || []), r]);
  const active = new Set((await Society.find({ _id: { $in: [...bySociety.keys()] }, active: true }).select('_id').lean()).map((s) => String(s._id)));
  let notified = 0;
  for (const [sid, list] of bySociety) {
    if (!active.has(sid)) continue;
    // eslint-disable-next-line no-await-in-loop
    await notifyRoles(sid, [ROLES.GUARD], {
      type: 'request',
      title: `Today: ${list.length} approved move${list.length > 1 ? 's' : ''}`,
      body: list.map((r) => `${KIND_LABEL[r.kind]} ${r.unitLabel} — ${moveSummary(r)}`).join('\n'),
      link: '/requests',
    });
    notified += list.length;
  }
  const ids = due.filter((r) => active.has(String(r.society))).map((r) => r._id);
  if (ids.length) await ServiceRequest.updateMany({ _id: { $in: ids } }, { 'move.guardsNotifiedOn': today });
  return { notified };
}

// ---- letter PDF ----

export async function letterPdf(ctx, id) {
  const manage = await canManage(ctx);
  const r = (await load(ctx, id, manage)).toObject();
  if (r.status !== 'approved' || !r.letter?.number) throw ApiError.conflict('The letter is issued once the request is approved');
  const society = await loadSociety(ctx.societyId);
  const buffer = await renderPdf((doc) => {
    letterhead(doc, society);
    doc.font('Helvetica').fontSize(10);
    const y = doc.y;
    doc.text(`Ref: ${r.letter.number}`, doc.page.margins.left, y);
    doc.text(`Date: ${longDate(r.letter.issuedAt)}`, doc.page.margins.left, y, { align: 'right' });
    doc.moveDown(1.2);
    doc.text(r.addressedTo || 'To whom it may concern', doc.page.margins.left);
    doc.moveDown(1);
    heading(doc, `Subject: ${r.letter.subject}`, 11);
    doc.font('Helvetica').fontSize(10.5);
    for (const para of r.letter.body.split(/\n{2,}/)) {
      doc.text(para.trim(), { align: 'justify', lineGap: 2 });
      doc.moveDown(0.8);
    }
    if (r.fees) {
      doc.font('Helvetica-Bold').text('Fees: ', { continued: true }).font('Helvetica').text(r.fees);
      doc.moveDown(0.5);
    }
    doc.fontSize(9).fillColor('#475569').text(`Request ${r.number} · ${r.unitLabel} · ${r.applicantName}`).fillColor('#0f172a');
    signatureBlock(doc, [r.letter.signatory], { label: `For ${society?.name || 'the society'}` });
  });
  return { buffer, filename: pdfName(`${r.letter.number}-${r.unitLabel}`) };
}
