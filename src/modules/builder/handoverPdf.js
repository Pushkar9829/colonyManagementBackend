import { pdfBuffer } from '../subscriptions/invoicePdf.js';
import { money } from '../../common/utils/money.js';

const rs = (paise) => money(paise).replace('₹', 'Rs. ');
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const CATEGORY_LABELS = { documents: 'Documents', funds: 'Funds', assets: 'Assets', other: 'Other' };

// Handover certificate: everything transferred from the builder to the residents' association, with both signatures.
export function handoverPdf({ society, handover }) {
  return pdfBuffer((doc) => {
    doc.fontSize(18).font('Helvetica-Bold').text('Handover of society to the association');
    doc.moveDown(0.3).fontSize(10).font('Helvetica').text(society.name);
    doc.fillColor('#64748b').text([society.address, society.city, society.state, society.pincode].filter(Boolean).join(', ')).fillColor('#000');
    doc.moveDown().text(`Status: ${handover.status.replace(/_/g, ' ')} · ${handover.progress.transferred} of ${handover.progress.total} items transferred`);

    for (const category of Object.keys(CATEGORY_LABELS)) {
      const items = handover.items.filter((i) => i.category === category);
      if (!items.length) continue;
      doc.moveDown().font('Helvetica-Bold').fontSize(12).text(CATEGORY_LABELS[category]).fontSize(9).font('Helvetica');
      for (const i of items) {
        if (doc.y > doc.page.height - 90) doc.addPage();
        const mark = i.status === 'transferred' ? '[x]' : i.status === 'not_applicable' ? '[n/a]' : '[ ]';
        const extra = [i.amount ? rs(i.amount) : null, i.quantity ? `qty ${i.quantity}` : null, i.reference ? `ref ${i.reference}` : null, i.transferredAt ? `on ${when(i.transferredAt)}` : null].filter(Boolean).join(' · ');
        doc.text(`${mark} ${i.title}${extra ? `  (${extra})` : ''}`);
        if (i.details) doc.fillColor('#64748b').text(`     ${i.details}`).fillColor('#000');
      }
    }

    if (doc.y > doc.page.height - 160) doc.addPage();
    doc.moveDown(2);
    const top = doc.y;
    const sign = (x, title, s) => {
      doc.font('Helvetica-Bold').fontSize(10).text(title, x, top);
      doc.font('Helvetica').fontSize(9);
      if (s?.at) {
        doc.text(`Signed by ${s.name}${s.designation ? ` (${s.designation})` : ''}`, x);
        doc.text(when(s.at), x);
        if (s.note) doc.text(s.note, x, undefined, { width: 220 });
      } else doc.fillColor('#64748b').text('Not signed yet', x).fillColor('#000');
    };
    sign(50, 'For the builder', handover.builderSignOff);
    sign(320, 'For the association', handover.associationSignOff);
    doc.fontSize(7).fillColor('#64748b').text('Signatures are recorded electronically in ColonyHub with the signer’s account and time.', 50, doc.page.height - 70, { width: 495 });
  });
}
