// Demo data for governance: committee, meetings, an election, statutory registers, documents and requests.
import CommitteeTerm from '../../src/modules/committee/committeeTerm.model.js';
import Meeting from '../../src/modules/meetings/meeting.model.js';
import Election from '../../src/modules/elections/election.model.js';
import Nomination from '../../src/modules/elections/nomination.model.js';
import RegisterMember from '../../src/modules/registers/registerMember.model.js';
import ShareCertificate from '../../src/modules/registers/shareCertificate.model.js';
import MemberNomination from '../../src/modules/registers/memberNomination.model.js';
import LibraryDocument from '../../src/modules/documents/document.model.js';
import DocumentFolder, { DEFAULT_FOLDERS } from '../../src/modules/documents/documentFolder.model.js';
import ServiceRequest from '../../src/modules/requests/serviceRequest.model.js';
import Counter from '../../src/modules/counter/counter.model.js';
import { storage } from '../../src/integrations/storage.js';
import { heading, letterhead, renderPdf } from '../../src/modules/committee/pdf.js';
import { addDays, localDateString } from '../../src/common/utils/dates.js';

const day = (n) => localDateString(addDays(new Date(), n));

async function samplePdf(society, title, lines) {
  const buffer = await renderPdf((doc) => {
    letterhead(doc, society);
    heading(doc, title);
    for (const l of lines) doc.text(l, { align: 'justify' }).moveDown(0.5);
  });
  const stored = await storage.save({ buffer, mimetype: 'application/pdf', folder: `${society._id}/documents` });
  return { url: stored.url, mimetype: 'application/pdf', name: `${title}.pdf` };
}

export default async function seed(s) {
  const { sid, society } = s;
  const admin = await s.user('admin@demo.test');
  const people = {};
  for (const email of ['resident@demo.test', 'vikram@demo.test', 'anita@demo.test', 'karan@demo.test']) {
    // eslint-disable-next-line no-await-in-loop
    people[email] = { user: await s.user(email), membership: await s.membership(email) };
  }
  const ravi = people['resident@demo.test'];
  const vikram = people['vikram@demo.test'];
  const anita = people['anita@demo.test'];
  const karan = people['karan@demo.test'];
  const adminMembership = await s.membership('admin@demo.test');
  const units = { a101: await s.unit('A-101'), a201: await s.unit('A-201'), b101: await s.unit('B-101'), b302: await s.unit('B-302') };

  // ---- committee: a dissolved past term and the sitting one ----
  const pos = (p, position, extra = {}) => ({ membership: p.membership._id, user: p.user._id, name: p.user.name, unitLabel: extra.unitLabel, position, ...extra });
  await CommitteeTerm.create({
    society: sid, name: 'Managing Committee 2021-2026', startDate: '2021-04-01', endDate: '2026-03-31', status: 'dissolved', dissolvedAt: new Date('2026-04-01'),
    positions: [pos(vikram, 'chairman', { unitLabel: 'A-201', active: false, from: '2021-04-01', to: '2026-03-31' }), pos(anita, 'treasurer', { unitLabel: 'B-101', active: false, from: '2021-04-01', to: '2026-03-31' })],
  });
  await CommitteeTerm.create({
    society: sid, name: 'Managing Committee 2026-2031', startDate: '2026-04-01', endDate: '2031-03-31', status: 'active', activatedAt: new Date('2026-04-01'), createdBy: admin._id,
    positions: [
      pos(ravi, 'chairman', { unitLabel: 'A-101', isSignatory: true, from: '2026-04-01' }),
      { membership: adminMembership._id, user: admin._id, name: admin.name, position: 'secretary', isSignatory: true, from: '2026-04-01' },
      pos(anita, 'treasurer', { unitLabel: 'B-101', from: '2026-04-01' }),
      pos(vikram, 'member', { unitLabel: 'A-201', from: '2026-04-01' }),
    ],
  });
  const signers = [{ name: ravi.user.name, position: 'Chairman' }, { name: admin.name, position: 'Secretary' }];

  // ---- meetings: last AGM (minutes approved) and an upcoming committee meeting ----
  const agmAgenda = [
    { title: 'Confirmation of minutes of the previous AGM', minutes: 'Minutes of the AGM held on 24 September 2025 were read and confirmed.' },
    { title: 'Adoption of audited accounts for 2025-26', minutes: 'The Treasurer presented the audited statement of accounts. Members raised queries on the sinking fund which were answered.' },
    { title: 'Appointment of statutory auditor', minutes: 'M/s Kale & Associates were proposed for re-appointment.' },
  ];
  const attendance = [ravi, vikram, anita].map((p, i) => ({ membership: p.membership._id, user: p.user._id, name: p.user.name, unitLabel: ['A-101', 'A-201', 'B-101'][i], mode: i === 2 ? 'online' : 'in_person', markedBy: admin._id }));
  const agm = new Meeting({
    society: sid, number: 'MTG-000001', title: 'Annual General Meeting 2026', type: 'agm', scheduledAt: addDays(new Date(), -20), venue: 'Clubhouse lawn', mode: 'hybrid',
    audience: { type: 'owners' }, quorum: { type: 'count', value: 3 }, agenda: agmAgenda, status: 'completed',
    notice: { sentAt: addDays(new Date(), -35), count: 1, recipients: 5 }, attendance, createdBy: admin._id,
    minutes: { status: 'approved', summary: 'The meeting was chaired by the Chairman. Quorum being present, the meeting was called to order at 10:30 AM.', approvedBy: admin._id, approvedAt: addDays(new Date(), -18), signatories: signers },
  });
  agm.resolutions.push({
    number: 'R-1', agendaItem: agm.agenda[1]._id, title: 'Adoption of accounts', text: 'Resolved that the audited accounts for the year 2025-26 be and are hereby adopted.',
    proposedBy: vikram.membership._id, proposedByName: vikram.user.name, secondedBy: anita.membership._id, secondedByName: anita.user.name, votesFor: 3, votesAgainst: 0, abstain: 0, result: 'passed', recordedBy: admin._id,
  });
  agm.actionItems.push({ title: 'Send appointment letter to the auditor', owner: adminMembership._id, ownerUser: admin._id, ownerName: admin.name, dueDate: day(10), status: 'in_progress' });
  agm.actionItems.push({ title: 'Get three quotes for terrace waterproofing', owner: vikram.membership._id, ownerUser: vikram.user._id, ownerName: vikram.user.name, dueDate: day(-2), status: 'open' });
  await agm.save();
  await Meeting.create({
    society: sid, number: 'MTG-000002', title: 'Managing Committee meeting — October', type: 'committee', scheduledAt: addDays(new Date(), 6), venue: 'Society office',
    audience: { type: 'committee' }, quorum: { type: 'count', value: 3 }, status: 'scheduled', notice: { sentAt: new Date(), count: 1, recipients: 4 }, createdBy: admin._id,
    agenda: [{ title: 'Lift AMC renewal' }, { title: 'Pending maintenance dues follow-up' }, { title: 'Terrace waterproofing quotes' }],
  });
  await Counter.updateOne({ society: sid, key: 'meeting' }, { $max: { seq: 2 } }, { upsert: true });

  // ---- election with nominations open ----
  const election = await Election.create({
    society: sid, number: 'ELN-000001', title: 'Election of committee members (casual vacancy)', status: 'nominations', eligibility: 'unit_owner',
    positions: [{ title: 'Joint Secretary', seats: 1 }, { title: 'Committee Member', seats: 2 }],
    nominationStart: addDays(new Date(), -2), nominationEnd: addDays(new Date(), 5), votingStart: addDays(new Date(), 7), votingEnd: addDays(new Date(), 9),
    audit: [{ by: admin._id, action: 'created' }, { by: admin._id, action: 'open-nominations' }], createdBy: admin._id,
  });
  await Nomination.create({
    society: sid, election: election._id, position: election.positions[1]._id, candidate: vikram.membership._id, candidateUser: vikram.user._id, candidateName: vikram.user.name,
    unitLabel: 'A-201', nominatedBy: vikram.user._id, nominatedByName: vikram.user.name, statement: 'Will follow up on the waterproofing work.', status: 'accepted', acceptedAt: new Date(),
  });
  await Counter.updateOne({ society: sid, key: 'election' }, { $max: { seq: 1 } }, { upsert: true });

  // ---- statutory registers ----
  const members = [];
  for (const [i, [p, unit, admitted]] of [[ravi, units.a101, '2015-06-01'], [vikram, units.a201, '2015-06-01'], [anita, units.b101, '2018-02-15']].entries()) {
    // eslint-disable-next-line no-await-in-loop
    members.push(await RegisterMember.create({ society: sid, memberNo: i + 1, membership: p.membership._id, user: p.user._id, name: p.user.name, unit: unit._id, unitLabel: unit.label, admissionDate: admitted, entranceFee: 10000, occupation: 'Service' }));
  }
  for (const [i, m] of members.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await ShareCertificate.create({ society: sid, certificateNo: i + 1, member: m._id, unit: m.unit, unitLabel: m.unitLabel, shareFrom: i * 10 + 1, shareTo: i * 10 + 10, shareCount: 10, faceValue: 5000, issueDate: m.admissionDate, issuedBy: admin._id });
  }
  await MemberNomination.create({
    society: sid, member: members[0]._id, nominationDate: '2019-01-10', recordedBy: admin._id,
    nominees: [{ name: 'Priya Iyer', relation: 'Spouse', sharePercent: 70 }, { name: 'Arav Iyer', relation: 'Son', sharePercent: 30 }], witnesses: [{ name: 'Suresh Kulkarni' }],
  });
  await Counter.bulkWrite([
    ['register-member', 3], ['share-certificate', 3], ['share-no', 30],
  ].map(([key, seq]) => ({ updateOne: { filter: { society: sid, key }, update: { $max: { seq } }, upsert: true } })));

  // ---- document library ----
  const folders = {};
  for (const [order, name] of DEFAULT_FOLDERS.entries()) {
    const slug = name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // eslint-disable-next-line no-await-in-loop
    folders[name] = await DocumentFolder.findOneAndUpdate({ society: sid, slug }, { $setOnInsert: { name, system: true, order } }, { upsert: true, returnDocument: 'after' });
  }
  const byeLaws = await samplePdf(society, 'Bye-laws of the Society', ['These bye-laws govern the admission of members, the management of the society by the Managing Committee, general meetings, funds and the maintenance of the building.']);
  const insurance = await samplePdf(society, 'Building Insurance Policy', ['Policy covering fire, earthquake and allied perils for the society buildings. Sum insured: Rs. 12,00,00,000.']);
  const minutes = await samplePdf(society, 'Minutes of AGM 2026', ['Summary minutes of the Annual General Meeting 2026.']);
  const doc = (folder, title, file, extra = {}) => ({ society: sid, folder: folders[folder]._id, title, currentVersion: 1, versions: [{ version: 1, ...file, uploadedBy: admin._id }], createdBy: admin._id, ...extra });
  await LibraryDocument.insertMany([
    doc('Bye-laws', 'Registered bye-laws (2019 amendment)', byeLaws, { tags: ['bye-laws', 'legal'] }),
    doc('Insurance', 'Building insurance policy 2025-26', insurance, { tags: ['insurance', 'policy'], expiryDate: day(20), remindDaysBefore: 30 }),
    doc('AGM minutes', 'AGM 2026 — approved minutes', minutes, { tags: ['agm', '2026'] }),
    doc('Agreements', 'Lift AMC agreement (draft)', byeLaws, { tags: ['lift', 'amc'], visibility: { type: 'committee', roles: [] }, expiryDate: day(45) }),
  ]);

  // ---- requests: a pending sale NOC and an approved move-in for today ----
  await ServiceRequest.create({
    society: sid, number: 'REQ-000001', kind: 'noc', nocType: 'bank_loan', unit: units.a101._id, unitLabel: 'A-101', raisedBy: ravi.user._id, applicantName: ravi.user.name, residentType: 'owner',
    addressedTo: 'The Branch Manager, State Bank of India, Baner', info: { bankName: 'State Bank of India', loanAmount: 450000000 }, history: [{ by: ravi.user._id, to: 'pending' }],
  });
  await ServiceRequest.create({
    society: sid, number: 'REQ-000002', kind: 'move_in', unit: units.b302._id, unitLabel: 'B-302', raisedBy: karan.user._id, applicantName: karan.user.name, residentType: 'tenant',
    move: { date: day(0), from: '10:00', to: '14:00', liftBooking: true, vehicleNumber: 'MH12QX4421', vehicleType: 'Tempo', moversCompany: 'Agarwal Packers', tenancy: 'tenant' },
    attachments: [{ ...byeLaws, name: 'leave-and-licence-agreement.pdf' }], status: 'approved', decidedBy: admin._id, decidedAt: new Date(),
    history: [{ by: karan.user._id, to: 'pending' }, { by: admin._id, from: 'pending', to: 'approved' }],
    letter: { number: 'LTR-000001', issuedAt: new Date(), subject: 'Permission to move in', body: `This is to confirm that ${karan.user.name} has been granted permission to move in to Flat No. B-302 today between 10:00 and 14:00.\n\nSecurity staff are requested to allow the movers during this time.`, signatory: signers[1] },
  });
  await Counter.bulkWrite([['service-request', 2], ['request-letter', 1]].map(([key, seq]) => ({ updateOne: { filter: { society: sid, key }, update: { $max: { seq } }, upsert: true } })));
}
