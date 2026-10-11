import PDFDocument from 'pdfkit';
import Society from '../society/society.model.js';

// Shared pdfkit helpers for governance documents: minutes, letters, certificates, registers.
// Services build a Buffer; controllers only set headers and send it.

export function renderPdf(build, options = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, ...options });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    Promise.resolve(build(doc))
      .then(() => {
        footerPageNumbers(doc);
        doc.end();
      })
      .catch(reject);
  });
}

export const loadSociety = (societyId) => Society.findById(societyId).select('name address city state pincode contactEmail contactPhone').lean();

export const societyAddress = (s) => [s?.address, s?.city, s?.state && s?.pincode ? `${s.state} ${s.pincode}` : s?.state || s?.pincode].filter(Boolean).join(', ');

// Society name, address and contact centred at the top, with a rule beneath.
export function letterhead(doc, society) {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a').text(society?.name || 'Housing Society', left, doc.page.margins.top, { width, align: 'center' });
  const addr = societyAddress(society);
  doc.font('Helvetica').fontSize(9).fillColor('#475569');
  if (addr) doc.text(addr, { width, align: 'center' });
  const contact = [society?.contactPhone && `Phone: ${society.contactPhone}`, society?.contactEmail && `Email: ${society.contactEmail}`].filter(Boolean).join('   ');
  if (contact) doc.text(contact, { width, align: 'center' });
  doc.moveDown(0.5);
  const y = doc.y;
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor('#94a3b8').stroke();
  doc.moveDown(1);
  doc.fillColor('#0f172a');
}

export function heading(doc, text, size = 13) {
  doc.font('Helvetica-Bold').fontSize(size).fillColor('#0f172a').text(text, { align: 'center' });
  doc.moveDown(0.6);
  doc.font('Helvetica').fontSize(10.5);
}

export function sectionTitle(doc, text) {
  ensureSpace(doc, 60);
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(text);
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10).fillColor('#1e293b');
}

// "Label: value" lines.
export function keyValues(doc, rows) {
  for (const [k, v] of rows) {
    if (v === undefined || v === null || v === '') continue;
    doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(String(v));
  }
}

export function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

// Simple table: columns [{ header, width (fraction), key | render(row) }].
export function table(doc, columns, rows) {
  const { left, right } = doc.page.margins;
  const total = doc.page.width - left - right;
  const widths = columns.map((c) => c.width * total);
  const drawRow = (cells, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    const heights = cells.map((t, i) => doc.heightOfString(String(t ?? ''), { width: widths[i] - 6 }));
    const h = Math.max(...heights) + 6;
    ensureSpace(doc, h + 4);
    const y = doc.y;
    let x = left;
    cells.forEach((t, i) => {
      doc.text(String(t ?? ''), x + 3, y + 3, { width: widths[i] - 6 });
      x += widths[i];
    });
    doc.moveTo(left, y + h).lineTo(left + total, y + h).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
    doc.x = left;
    doc.y = y + h;
  };
  drawRow(columns.map((c) => c.header), true);
  for (const row of rows) drawRow(columns.map((c) => (c.render ? c.render(row) : row[c.key])), false);
  doc.moveDown(0.5);
  doc.x = left;
}

// Signature lines side by side (wraps after three).
export function signatureBlock(doc, signatories, { label = 'For and on behalf of the society' } = {}) {
  const list = signatories.length ? signatories : [{ name: '', position: 'Hon. Secretary' }];
  const { left, right } = doc.page.margins;
  const total = doc.page.width - left - right;
  ensureSpace(doc, 120);
  doc.moveDown(1.5);
  doc.font('Helvetica').fontSize(9.5).fillColor('#334155').text(label, left);
  doc.moveDown(2.5);
  const perRow = Math.min(3, list.length);
  const colW = total / perRow;
  for (let i = 0; i < list.length; i += perRow) {
    ensureSpace(doc, 60);
    const y = doc.y;
    list.slice(i, i + perRow).forEach((s, j) => {
      const x = left + j * colW;
      doc.moveTo(x + 5, y).lineTo(x + colW - 15, y).lineWidth(0.7).strokeColor('#475569').stroke();
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0f172a').text(s.name || ' ', x + 5, y + 4, { width: colW - 20 });
      doc.font('Helvetica').fontSize(9).fillColor('#475569').text(s.position || '', x + 5, doc.y, { width: colW - 20 });
    });
    doc.x = left;
    doc.y = y + 45;
  }
  doc.fillColor('#0f172a');
}

export function watermark(doc, text) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.save();
    doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font('Helvetica-Bold').fontSize(70).fillColor('#e2e8f0').opacity(0.6)
      .text(text, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false });
    doc.restore();
    doc.opacity(1);
  }
}

function footerPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  if (range.count < 2) return;
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the margin must not trigger a new page
    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
      .text(`Page ${i + 1} of ${range.count}`, 0, doc.page.height - 30, { width: doc.page.width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

export const longDate = (iso) => {
  if (!iso) return '';
  const d = typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00+05:30`) : new Date(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
};

export const dateTimeIST = (d) =>
  d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '';

// Content-Disposition safe file name.
export const pdfName = (s) => `${String(s).replace(/[^\w.-]+/g, '_').slice(0, 80)}.pdf`;
