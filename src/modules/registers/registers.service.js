import RegisterMember from './registerMember.model.js';
import ShareCertificate from './shareCertificate.model.js';
import ShareTransfer from './shareTransfer.model.js';
import MemberNomination from './memberNomination.model.js';
import Counter from '../counter/counter.model.js';
import Membership from '../users/membership.model.js';
import Unit from '../units/unit.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { money } from '../../common/utils/money.js';
import { withTransaction } from '../../common/utils/transaction.js';
import { nextSeq } from '../counter/counter.service.js';
import * as audit from '../audit/audit.service.js';
import { canManage, signatories } from '../committee/committee.service.js';
import { heading, letterhead, loadSociety, longDate, pdfName, renderPdf, sectionTitle, signatureBlock, table, watermark } from '../committee/pdf.js';

// ---- helpers ----

async function unitLabel(ctx, unitId) {
  if (!unitId) return undefined;
  const unit = await Unit.findOne({ _id: unitId, society: ctx.societyId }).select('label').lean();
  if (!unit) throw ApiError.badRequest('Unit not found');
  return unit.label;
}

async function loadMember(ctx, id, session) {
  const m = await RegisterMember.findOne({ _id: id, society: ctx.societyId }).session(session || null);
  if (!m) throw ApiError.notFound('Register entry not found');
  return m;
}

// Members may read entries linked to their own login; the committee reads everything.
async function assertCanRead(ctx, member) {
  if (String(member.user) === String(ctx.userId)) return;
  if (!(await canManage(ctx))) throw ApiError.notFound('Register entry not found');
}

async function sharesHeld(societyId, memberIds) {
  const rows = await ShareCertificate.aggregate([
    { $match: { society: societyId, member: { $in: memberIds }, status: 'active' } },
    { $group: { _id: '$member', shares: { $sum: '$shareCount' }, certificates: { $push: '$certificateNo' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

const withShares = (members, map) => members.map((m) => ({ ...m, sharesHeld: map.get(String(m._id))?.shares || 0, certificateNos: map.get(String(m._id))?.certificates || [] }));

// ---- member register (I-Form) ----

export async function listMembers(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.status) filter.status = filters.status;
  if (filters.search) {
    const rx = { $regex: escapeRegex(filters.search), $options: 'i' };
    filter.$or = [{ name: rx }, { unitLabel: rx }];
  }
  const result = await paginate(RegisterMember, filter, pagination, { sort: { memberNo: 1 } });
  result.items = withShares(result.items, await sharesHeld(ctx.societyId, result.items.map((m) => m._id)));
  return result;
}

async function membershipDetails(ctx, membershipId) {
  const m = await Membership.findOne({ _id: membershipId, society: ctx.societyId }).populate('user', 'name').lean();
  if (!m?.user) throw ApiError.badRequest('Linked member account not found');
  return m;
}

export async function createMember(ctx, data, session) {
  const doc = { ...data };
  if (data.membership) {
    const m = await membershipDetails(ctx, data.membership);
    doc.user = m.user._id;
    doc.name = data.name || m.user.name;
    doc.unit = data.unit || m.unit;
  }
  if (!doc.name) throw ApiError.badRequest('Member name is required');
  doc.unitLabel = await unitLabel(ctx, doc.unit);
  const [member] = await RegisterMember.create([{ ...doc, society: ctx.societyId, memberNo: await nextSeq(ctx.societyId, 'register-member', session) }], { session });
  audit.record(ctx, 'register.member_admitted', 'RegisterMember', member._id, { name: member.name, memberNo: member.memberNo });
  return member;
}

export async function getMember(ctx, id) {
  const member = await loadMember(ctx, id);
  await assertCanRead(ctx, member);
  return memberDetail(ctx, member.toObject());
}

async function memberDetail(ctx, member) {
  const [certificates, nominations, transfers] = await Promise.all([
    ShareCertificate.find({ society: ctx.societyId, $or: [{ member: member._id }, { 'endorsements.fromMember': member._id }] }).sort({ certificateNo: 1 }).lean(),
    MemberNomination.find({ society: ctx.societyId, member: member._id }).sort({ createdAt: -1 }).lean(),
    ShareTransfer.find({ society: ctx.societyId, $or: [{ transferor: member._id }, { transferee: member._id }] }).sort({ transferNo: -1 }).lean(),
  ]);
  const sharesHeldNow = certificates.filter((c) => c.status === 'active' && String(c.member) === String(member._id)).reduce((s, c) => s + c.shareCount, 0);
  return { ...member, sharesHeld: sharesHeldNow, certificates, nominations, transfers };
}

export async function updateMember(ctx, id, data) {
  const member = await loadMember(ctx, id);
  if (data.membership) {
    const m = await membershipDetails(ctx, data.membership);
    member.user = m.user._id;
  }
  if (data.unit) member.unitLabel = await unitLabel(ctx, data.unit);
  Object.assign(member, data);
  await member.save();
  audit.record(ctx, 'register.member_updated', 'RegisterMember', member._id, { fields: Object.keys(data) });
  return memberDetail(ctx, member.toObject());
}

export async function ceaseMember(ctx, id, { date, reason }) {
  const member = await loadMember(ctx, id);
  if (member.status === 'ceased') throw ApiError.conflict('Membership has already ceased');
  if (await ShareCertificate.exists({ society: ctx.societyId, member: member._id, status: 'active' })) {
    throw ApiError.conflict('Transfer or cancel this member\'s share certificates first');
  }
  Object.assign(member, { status: 'ceased', cessationDate: date, cessationReason: reason });
  await member.save();
  audit.record(ctx, 'register.member_ceased', 'RegisterMember', member._id, { reason });
  return memberDetail(ctx, member.toObject());
}

// Entries linked to the signed-in member.
export async function mine(ctx) {
  const members = await RegisterMember.find({ society: ctx.societyId, user: ctx.userId }).sort({ memberNo: 1 }).lean();
  return Promise.all(members.map((m) => memberDetail(ctx, m)));
}

// J-Form: list of members.
export async function jForm(ctx) {
  const members = await RegisterMember.find({ society: ctx.societyId, status: 'active' }).sort({ memberNo: 1 }).lean();
  return withShares(members, await sharesHeld(ctx.societyId, members.map((m) => m._id)));
}

export async function jFormPdf(ctx) {
  const [society, members] = await Promise.all([loadSociety(ctx.societyId), jForm(ctx)]);
  const buffer = await renderPdf((doc) => {
    letterhead(doc, society);
    heading(doc, 'FORM "J" — List of Members');
    doc.fontSize(9).fillColor('#475569').text(`As on ${longDate(new Date())}. Total members: ${members.length}`, { align: 'center' }).fillColor('#0f172a');
    doc.moveDown(0.8);
    table(doc, [
      { header: 'Sr.', width: 0.07, render: (r) => r.i },
      { header: 'Member no.', width: 0.1, key: 'memberNo' },
      { header: 'Full name of member', width: 0.33, key: 'name' },
      { header: 'Flat', width: 0.1, key: 'unitLabel' },
      { header: 'Address', width: 0.26, render: (r) => r.address || '' },
      { header: 'Shares', width: 0.14, render: (r) => r.sharesHeld },
    ], members.map((m, i) => ({ ...m, i: i + 1 })));
    signatureBlock(doc, [{ name: '', position: 'Hon. Secretary' }], { label: 'Certified true copy' });
  });
  return { buffer, filename: pdfName('J-Form') };
}

// ---- share certificates ----

// Distinctive numbers are drawn from an atomic per-society counter, so concurrent issues never overlap.
// A manually given starting number (for back-filling old certificates) is checked against every
// existing range and pushes the counter forward if it lies beyond it.
async function allocateShares(societyId, count, from, session) {
  if (from) {
    const to = from + count - 1;
    const clash = await ShareCertificate.findOne({ society: societyId, shareFrom: { $lte: to }, shareTo: { $gte: from } }).session(session || null).lean();
    if (clash) throw ApiError.conflict(`Shares ${from}-${to} overlap certificate No. ${clash.certificateNo} (${clash.shareFrom}-${clash.shareTo})`);
    await Counter.updateOne({ society: societyId, key: 'share-no' }, { $max: { seq: to } }, { upsert: true, session });
    return { shareFrom: from, shareTo: to };
  }
  const c = await Counter.findOneAndUpdate({ society: societyId, key: 'share-no' }, { $inc: { seq: count } }, { upsert: true, returnDocument: 'after', session });
  return { shareFrom: c.seq - count + 1, shareTo: c.seq };
}

export async function listCertificates(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.status) filter.status = filters.status;
  if (filters.member) filter.member = filters.member;
  return paginate(ShareCertificate, filter, pagination, { sort: { certificateNo: 1 }, populate: { path: 'member', select: 'name memberNo status' } });
}

export async function issueCertificate(ctx, { member: memberId, shareCount, faceValue, issueDate, shareFrom, unit }) {
  const member = await loadMember(ctx, memberId);
  if (member.status !== 'active') throw ApiError.conflict('Certificates are issued only to active members');
  const range = await allocateShares(ctx.societyId, shareCount, shareFrom);
  const unitId = unit || member.unit;
  const cert = await ShareCertificate.create({
    society: ctx.societyId,
    certificateNo: await nextSeq(ctx.societyId, 'share-certificate'),
    member: member._id,
    unit: unitId,
    unitLabel: await unitLabel(ctx, unitId),
    ...range,
    shareCount,
    faceValue,
    issueDate,
    issuedBy: ctx.userId,
  });
  audit.record(ctx, 'register.certificate_issued', 'ShareCertificate', cert._id, { certificateNo: cert.certificateNo, shares: `${cert.shareFrom}-${cert.shareTo}` });
  return cert.toObject();
}

async function loadCertificate(ctx, id, session) {
  const cert = await ShareCertificate.findOne({ _id: id, society: ctx.societyId }).session(session || null);
  if (!cert) throw ApiError.notFound('Share certificate not found');
  return cert;
}

export async function getCertificate(ctx, id) {
  const cert = await loadCertificate(ctx, id);
  const member = await RegisterMember.findById(cert.member).lean();
  if (String(member?.user) !== String(ctx.userId) && !(await canManage(ctx))) throw ApiError.notFound('Share certificate not found');
  return { ...cert.toObject(), member };
}

export async function cancelCertificate(ctx, id, { reason }) {
  const cert = await loadCertificate(ctx, id);
  if (cert.status === 'cancelled') throw ApiError.conflict('Already cancelled');
  cert.status = 'cancelled';
  cert.cancelledReason = reason;
  await cert.save();
  audit.record(ctx, 'register.certificate_cancelled', 'ShareCertificate', cert._id, { reason });
  return cert.toObject();
}

export async function certificatePdf(ctx, id) {
  const cert = await getCertificate(ctx, id);
  const [society, signers] = await Promise.all([loadSociety(ctx.societyId), signatories(ctx.societyId)]);
  const buffer = await renderPdf((doc) => {
    const { width, height } = doc.page;
    doc.rect(25, 25, width - 50, height - 50).lineWidth(3).strokeColor('#1e3a8a').stroke();
    doc.rect(32, 32, width - 64, height - 64).lineWidth(0.8).strokeColor('#1e3a8a').stroke();
    doc.y = 60;
    letterhead(doc, society);
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#1e3a8a').text('SHARE CERTIFICATE', { align: 'center', characterSpacing: 2 });
    doc.moveDown(0.6);
    doc.font('Helvetica').fontSize(10.5).fillColor('#0f172a');
    const row = (leftText, rightText) => {
      const y = doc.y;
      doc.text(leftText, 60, y, { width: (width - 120) / 2 });
      doc.text(rightText, width / 2, y, { width: (width - 120) / 2, align: 'right' });
      doc.moveDown(0.3);
    };
    row(`Certificate No.: ${cert.certificateNo}`, `Member Reg. No.: ${cert.member?.memberNo ?? '—'}`);
    row(`Flat No.: ${cert.unitLabel || '—'}`, `Distinctive Nos.: ${cert.shareFrom} to ${cert.shareTo}`);
    doc.moveDown(1.2);
    doc.font('Helvetica').fontSize(12).text(
      `This is to certify that ${cert.member?.name || '—'} is the Registered Holder of ${cert.shareCount} fully paid-up share(s) of ${money(cert.faceValue)} each, bearing distinctive numbers from ${cert.shareFrom} to ${cert.shareTo} (both inclusive), in ${society?.name || 'the society'}, subject to the bye-laws of the said society.`,
      60,
      doc.y,
      { width: width - 120, align: 'justify', lineGap: 4 },
    );
    doc.moveDown(1);
    doc.text(`Total amount paid: ${money(cert.faceValue * cert.shareCount)}`, 60);
    doc.moveDown(0.5);
    doc.text(`Given under the common seal of the society on ${longDate(cert.issueDate)}.`, 60);
    doc.x = 60;
    signatureBlock(doc, signers.length ? signers.slice(0, 3) : [{ name: '', position: 'Chairman' }, { name: '', position: 'Hon. Secretary' }, { name: '', position: 'Committee Member' }], { label: '' });

    doc.addPage();
    doc.rect(25, 25, width - 50, height - 50).lineWidth(1).strokeColor('#1e3a8a').stroke();
    doc.y = 60;
    doc.x = 50;
    heading(doc, 'Memorandum of Transfer of the Within-mentioned Shares');
    if (cert.endorsements.length) {
      table(doc, [
        { header: 'Date', width: 0.18, render: (r) => longDate(r.date) },
        { header: 'Transfer no.', width: 0.14, render: (r) => r.transferNo || '—' },
        { header: 'Transferor', width: 0.27, key: 'fromName' },
        { header: 'Transferee', width: 0.27, key: 'toName' },
        { header: 'Sign', width: 0.14, render: () => '' },
      ], cert.endorsements);
    } else {
      doc.fontSize(10).fillColor('#475569').text('No transfers recorded.', { align: 'center' }).fillColor('#0f172a');
    }
    if (cert.status === 'cancelled') watermark(doc, 'CANCELLED');
  });
  return { buffer, filename: pdfName(`Share-Certificate-${cert.certificateNo}`) };
}

// ---- transfers ----

export async function transfer(ctx, data) {
  const result = await withTransaction(async (session) => {
    const cert = await loadCertificate(ctx, data.certificate, session);
    if (cert.status !== 'active') throw ApiError.conflict('Only an active certificate can be transferred');
    const transferor = await loadMember(ctx, cert.member, session);
    let transferee;
    if (data.transferee) {
      transferee = await loadMember(ctx, data.transferee, session);
      if (transferee.status !== 'active') throw ApiError.conflict('The transferee is not an active member');
    } else {
      transferee = await createMember(ctx, { admissionDate: data.date, unit: cert.unit, ...data.newMember }, session);
    }
    if (String(transferee._id) === String(transferor._id)) throw ApiError.badRequest('Transferor and transferee must be different');

    const [record] = await ShareTransfer.create([{
      society: ctx.societyId,
      transferNo: await nextSeq(ctx.societyId, 'share-transfer', session),
      certificate: cert._id,
      certificateNo: cert.certificateNo,
      shareFrom: cert.shareFrom,
      shareTo: cert.shareTo,
      unit: cert.unit,
      unitLabel: cert.unitLabel,
      transferor: transferor._id,
      transferorName: transferor.name,
      transferee: transferee._id,
      transfereeName: transferee.name,
      date: data.date,
      reason: data.reason,
      transferFee: data.transferFee,
      premium: data.premium,
      meetingRef: data.meetingRef,
      remarks: data.remarks,
      recordedBy: ctx.userId,
    }], { session });

    cert.member = transferee._id;
    cert.endorsements.push({ date: data.date, transfer: record._id, transferNo: record.transferNo, fromMember: transferor._id, fromName: transferor.name, toMember: transferee._id, toName: transferee.name });
    await cert.save({ session });

    // A member who no longer holds any shares ceases to be a member.
    const stillHolds = await ShareCertificate.exists({ society: ctx.societyId, member: transferor._id, status: 'active' }).session(session || null);
    if (!stillHolds) {
      transferor.status = 'ceased';
      transferor.cessationDate = data.date;
      transferor.cessationReason = `Shares transferred to ${transferee.name} (transfer No. ${record.transferNo})`;
      await transferor.save({ session });
    }
    return record;
  });
  audit.record(ctx, 'register.shares_transferred', 'ShareTransfer', result._id, { certificateNo: result.certificateNo, from: result.transferorName, to: result.transfereeName });
  return result.toObject();
}

export function listTransfers(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.member) filter.$or = [{ transferor: filters.member }, { transferee: filters.member }];
  return paginate(ShareTransfer, filter, pagination, { sort: { transferNo: -1 } });
}

// ---- nominations ----

export async function listNominations(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.member) filter.member = filters.member;
  if (filters.status) filter.status = filters.status;
  return paginate(MemberNomination, filter, pagination, { populate: { path: 'member', select: 'name memberNo unitLabel' } });
}

export async function createNomination(ctx, data) {
  const member = await loadMember(ctx, data.member);
  if (member.status !== 'active') throw ApiError.conflict('Nominations are recorded only for active members');
  const nomination = await withTransaction(async (session) => {
    await MemberNomination.updateMany({ society: ctx.societyId, member: member._id, status: 'active' }, { status: 'revoked', revokedAt: new Date() }, { session });
    const [n] = await MemberNomination.create([{ ...data, society: ctx.societyId, member: member._id, recordedBy: ctx.userId }], { session });
    return n;
  });
  audit.record(ctx, 'register.nomination_recorded', 'MemberNomination', nomination._id, { member: member.name, nominees: data.nominees.length });
  return nomination.toObject();
}

export async function revokeNomination(ctx, id) {
  const n = await MemberNomination.findOneAndUpdate({ _id: id, society: ctx.societyId, status: 'active' }, { status: 'revoked', revokedAt: new Date() }, { returnDocument: 'after' }).lean();
  if (!n) throw ApiError.notFound('Active nomination not found');
  audit.record(ctx, 'register.nomination_revoked', 'MemberNomination', n._id);
  return n;
}
