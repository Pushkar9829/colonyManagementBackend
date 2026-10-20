import PDFDocument from 'pdfkit';
import { money } from '../../common/utils/money.js';
import { localDateString } from '../../common/utils/dates.js';

// pdfkit's built-in fonts have no ₹ glyph, so amounts are printed as "Rs." in PDFs.
const rs = (paise) => money(paise).replace('₹', 'Rs. ');
const d = (date) => (date ? localDateString(date) : '-');

export function pdfBuffer(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

// Tax invoice for a platform subscription period.
export function invoicePdf({ invoice, society, subscription }) {
  return pdfBuffer((doc) => {
    doc.fontSize(20).font('Helvetica-Bold').text('ColonyHub', { continued: true }).font('Helvetica').fontSize(12).text('   Tax invoice', { baseline: 'alphabetic' });
    doc.moveDown(0.3).fontSize(9).fillColor('#64748b').text('Society management platform subscription').fillColor('#000');
    doc.moveDown();

    const top = doc.y;
    doc.fontSize(10).font('Helvetica-Bold').text('Billed to', 50, top).font('Helvetica');
    doc.text(society.name);
    for (const line of [society.address, [society.city, society.state, society.pincode].filter(Boolean).join(', ')]) if (line) doc.text(line);
    if (subscription?.gstin) doc.text(`GSTIN: ${subscription.gstin}`);
    if (subscription?.billingEmail) doc.text(subscription.billingEmail);

    doc.font('Helvetica-Bold').text('Invoice', 350, top).font('Helvetica');
    doc.text(`Number: ${invoice.number}`, 350);
    doc.text(`Date: ${d(invoice.createdAt)}`, 350);
    doc.text(`Due: ${d(invoice.dueDate)}`, 350);
    doc.text(invoice.lifetime ? `Period: lifetime from ${d(invoice.periodStart)}` : `Period: ${d(invoice.periodStart)} to ${d(new Date(invoice.periodEnd.getTime() - 1))}`, 350);
    doc.text(`Status: ${invoice.status.toUpperCase()}${invoice.paidAt ? ` (${d(invoice.paidAt)})` : ''}`, 350);

    doc.moveDown(2);
    let y = Math.max(doc.y, top + 110);
    doc.font('Helvetica-Bold').text('Description', 50, y).text('Amount', 430, y, { width: 115, align: 'right' });
    y += 16;
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#cbd5e1').stroke();
    y += 6;
    doc.font('Helvetica');
    for (const l of invoice.lines) {
      doc.text(l.description, 50, y, { width: 370 });
      doc.text(rs(l.amount), 430, y, { width: 115, align: 'right' });
      y = doc.y + 6;
    }
    doc.moveTo(50, y).lineTo(545, y).stroke();
    y += 8;
    const row = (label, value, bold) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, 280, y, { width: 150 }).text(value, 430, y, { width: 115, align: 'right' });
      y += 16;
    };
    row('Subtotal', rs(invoice.subtotal));
    row(`GST @ ${invoice.gstRate}%`, rs(invoice.gst));
    row('Total', rs(invoice.total), true);

    doc.font('Helvetica').fontSize(8).fillColor('#64748b');
    doc.text(
      `Plan: ${invoice.plan} · ${invoice.billingCycle.replace('_', '-')} · ${invoice.units} units. GST charged on the subtotal. This is a computer-generated invoice and needs no signature.`,
      50,
      y + 30,
      { width: 495 },
    );
  });
}
