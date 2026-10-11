import { money } from '../../common/utils/money.js';
import { longDate, societyAddress } from '../committee/pdf.js';

// Default wording for NOC and permission letters. The committee may edit the body before approving.

const NOC_SUBJECT = {
  sale: 'No Objection Certificate for sale / transfer of flat',
  passport: 'Address proof / No Objection Certificate for passport or visa',
  bank_loan: 'No Objection Certificate for housing loan',
  electricity: 'No Objection Certificate for electricity connection',
  gas: 'No Objection Certificate for piped gas connection',
  renovation: 'Permission for renovation / interior work',
  other: 'No Objection Certificate',
};

export function defaultLetter(request, society) {
  const name = request.applicantName || 'the member';
  const flat = `Flat No. ${request.unitLabel}`;
  const where = `${society?.name || 'the society'}${societyAddress(society) ? `, ${societyAddress(society)}` : ''}`;
  const i = request.info || {};
  const purpose = request.purpose ? ` for the purpose of ${request.purpose}` : '';
  const occupant = request.residentType === 'owner' ? 'a bona fide member and owner' : `a resident (${request.residentType || 'occupant'})`;

  if (request.kind === 'move_in' || request.kind === 'move_out') {
    const m = request.move || {};
    const verb = request.kind === 'move_in' ? 'move in to' : 'move out of';
    return {
      subject: request.kind === 'move_in' ? 'Permission to move in' : 'Permission to move out',
      body: [
        `This is to confirm that ${name} has been granted permission to ${verb} ${flat}, ${where}, on ${longDate(m.date)} between ${m.from} and ${m.to}.`,
        m.liftBooking ? 'The service lift has been reserved for this period.' : 'No lift booking has been made.',
        m.vehicleNumber ? `Vehicle permitted: ${m.vehicleNumber}${m.vehicleType ? ` (${m.vehicleType})` : ''}${m.moversCompany ? `, movers: ${m.moversCompany}` : ''}.` : null,
        'Security staff are requested to allow the movers during this time. The resident is responsible for any damage to common areas and must ensure that common passages are kept clear.',
      ].filter(Boolean).join('\n\n'),
    };
  }

  const opening = `This is to certify that ${name} is ${occupant} of ${flat}, ${where}.`;
  const specific = {
    sale: `The society has no objection to the proposed sale / transfer of the said flat${i.buyerName ? ` to ${i.buyerName}` : ''}, subject to compliance with the bye-laws of the society, payment of the transfer fee and premium as applicable, and the transferee applying for membership of the society.`,
    passport: `${name} has been residing at the above address. The society has no objection to this address being used${purpose || ' for the passport / visa application'}.`,
    bank_loan: `The society has no objection to the member mortgaging the said flat${i.bankName ? ` with ${i.bankName}` : ''}${i.loanAmount ? ` for a loan of ${money(i.loanAmount)}` : ''}. The society's first charge for its dues on the said flat shall continue to prevail.`,
    electricity: `The society has no objection to ${name} applying${i.provider ? ` to ${i.provider}` : ''} for a new / transferred electricity connection for the said flat.`,
    gas: `The society has no objection to ${name} applying${i.provider ? ` to ${i.provider}` : ''} for a piped gas connection for the said flat, subject to installation as per safety norms.`,
    renovation: `Permission is granted to carry out the following work in the said flat: ${i.workDescription || request.description || 'interior work'}${i.workFrom ? `, from ${longDate(i.workFrom)}${i.workTo ? ` to ${longDate(i.workTo)}` : ''}` : ''}${i.contractorName ? `, through ${i.contractorName}` : ''}. Work is permitted only between 10:00 and 18:00 on working days; no structural changes to columns, beams or the external facade are allowed; debris must be removed at the member's cost; and the member is responsible for any damage to common property or neighbouring flats.`,
    other: `The society has no objection to the request of the member${purpose}.${request.description ? ` ${request.description}` : ''}`,
  }[request.nocType || 'other'];

  return {
    subject: NOC_SUBJECT[request.nocType || 'other'],
    body: [opening, specific, 'This certificate is issued at the request of the member without any liability on the part of the society.'].join('\n\n'),
  };
}
