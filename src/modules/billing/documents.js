import PDFDocument from 'pdfkit';
import { localDateString } from '../../common/utils/dates.js';

// PDF renderers for bills (GST tax invoice when the bill carries GST), receipts and statements.
// The built-in PDF fonts have no ₹ glyph, so amounts print as "Rs. 1,234.00".

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const rs = (paise) => `Rs. ${inr.format((paise || 0) / 100)}`;
const day = (d) => (d ? localDateString(d).split('-').reverse().join('-') : '-');
const periodText = (p) => (p === 'OPENING' ? 'Opening balance' : p ? new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
const address = (s) => [s.address, s.city, s.state, s.pincode].filter(Boolean).join(', ');

const MARGIN = 48;
const GREY = '#64748b';
const INK = '#0f172a';
const LINE = '#e2e8f0';

function render(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Producer: 'ColonyHub', Creator: 'ColonyHub' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      build(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

const width = (doc) => doc.page.width - MARGIN * 2;

function header(doc, society, title, gstin) {
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(society.name, MARGIN, MARGIN);
  doc.font('Helvetica').fontSize(9).fillColor(GREY);
  if (address(society)) doc.text(address(society));
  if (gstin) doc.text(`GSTIN: ${gstin}`);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(title, MARGIN, MARGIN, { align: 'right', width: width(doc) });
  doc.moveDown(3);
  rule(doc);
}

function rule(doc) {
  doc.moveTo(MARGIN, doc.y).lineTo(doc.page.width - MARGIN, doc.y).strokeColor(LINE).lineWidth(1).stroke();
  doc.moveDown(0.6);
}

// Two-column key/value block.
function facts(doc, pairs) {
  const top = doc.y;
  const half = width(doc) / 2;
  pairs.forEach(([k, v], i) => {
    const x = MARGIN + (i % 2) * half;
    const y = top + Math.floor(i / 2) * 30;
    doc.font('Helvetica').fontSize(8).fillColor(GREY).text(k, x, y, { width: half - 10 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(String(v ?? '-'), x, y + 10, { width: half - 10 });
  });
  doc.y = top + Math.ceil(pairs.length / 2) * 30 + 6;
  doc.x = MARGIN;
}

// cols: [{ header, width (fraction), align }]
function table(doc, cols, rows, { boldLast = 0 } = {}) {
  const w = width(doc);
  const draw = (cells, { bold, fill } = {}) => {
    if (doc.y > doc.page.height - MARGIN - 40) doc.addPage();
    const y = doc.y;
    if (fill) doc.rect(MARGIN, y - 3, w, 18).fill(fill);
    let x = MARGIN;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(INK);
    let h = 0;
    cols.forEach((c, i) => {
      const cw = c.width * w;
      doc.text(String(cells[i] ?? ''), x + 4, y, { width: cw - 8, align: c.align || 'left' });
      h = Math.max(h, doc.y - y);
      x += cw;
    });
    doc.y = y + Math.max(h, 12) + 6;
    doc.moveTo(MARGIN, doc.y - 3).lineTo(MARGIN + w, doc.y - 3).strokeColor(LINE).lineWidth(0.5).stroke();
  };
  draw(cols.map((c) => c.header), { bold: true, fill: '#f1f5f9' });
  rows.forEach((r, i) => draw(r, { bold: i >= rows.length - boldLast }));
  doc.x = MARGIN;
}

function footer(doc, text) {
  doc.moveDown(1.5);
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text(text, MARGIN, doc.y, { width: width(doc), align: 'center' });
}

// Tax summary of a bill: taxable value (lines that carry GST), exempt value and the GST lines.
export function taxSummary(bill) {
  const gstLines = bill.lines.filter((l) => l.kind === 'gst' || l.account === '2300');
  const base = bill.lines.filter((l) => !gstLines.includes(l));
  const taxable = base.filter((l) => l.gstRate > 0).reduce((s, l) => s + l.amount, 0);
  const exempt = base.reduce((s, l) => s + l.amount, 0) - taxable;
  const cgst = gstLines.filter((l) => /^CGST/i.test(l.head)).reduce((s, l) => s + l.amount, 0);
  const sgst = gstLines.filter((l) => /^SGST/i.test(l.head)).reduce((s, l) => s + l.amount, 0);
  return { taxable, exempt, cgst, sgst, gst: cgst + sgst, gstLines, base };
}

export function billPdf({ society, bill, unit, billedTo }) {
  const tax = taxSummary(bill);
  const isInvoice = Boolean(bill.gstin) && tax.gst > 0;
  return render((doc) => {
    header(doc, society, isInvoice ? 'TAX INVOICE' : bill.kind === 'opening' ? 'OPENING BALANCE' : 'MAINTENANCE BILL', bill.gstin);
    facts(doc, [
      [isInvoice ? 'Invoice no.' : 'Bill no.', bill.billNumber],
      [isInvoice ? 'Invoice date' : 'Bill date', day(bill.createdAt)],
      ['Unit', unit?.label],
      ['Billing period', periodText(bill.period)],
      ['Billed to', billedTo || unit?.label],
      ['Due date', day(bill.dueDate)],
    ]);
    doc.moveDown(0.5);
    const showGst = isInvoice;
    const cols = showGst
      ? [{ header: 'Description', width: 0.6 }, { header: 'GST %', width: 0.15, align: 'right' }, { header: 'Amount', width: 0.25, align: 'right' }]
      : [{ header: 'Description', width: 0.7 }, { header: 'Amount', width: 0.3, align: 'right' }];
    const row = (l) => (showGst ? [l.head, l.gstRate > 0 ? `${l.gstRate}%` : 'Exempt', rs(l.amount)] : [l.head, rs(l.amount)]);
    const rows = tax.base.map(row);
    if (showGst) {
      rows.push(['Taxable value', '', rs(tax.taxable)]);
      if (tax.exempt) rows.push(['Exempt / non-taxable value', '', rs(tax.exempt)]);
    }
    for (const l of tax.gstLines) rows.push(showGst ? [l.head, '', rs(l.amount)] : [l.head, rs(l.amount)]);
    const pad = showGst ? [''] : [];
    rows.push(['Bill amount', ...pad, rs(bill.amount)]);
    if (bill.lateFee) rows.push(['Late fee', ...pad, rs(bill.lateFee)]);
    if (bill.waived) rows.push(['Less: waiver', ...pad, `- ${rs(bill.waived)}`]);
    rows.push(['Total', ...pad, rs(bill.total)]);
    if (bill.creditApplied) rows.push(['Less: advance adjusted', ...pad, `- ${rs(bill.creditApplied)}`]);
    const cash = bill.paid - (bill.creditApplied || 0);
    if (cash > 0) rows.push(['Less: paid', ...pad, `- ${rs(cash)}`]);
    rows.push(['Balance due', ...pad, rs(Math.max(0, bill.total - bill.paid))]);
    table(doc, cols, rows, { boldLast: 1 });

    if (bill.meters?.length) {
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Meter readings');
      doc.moveDown(0.3);
      table(
        doc,
        [{ header: 'Meter', width: 0.28 }, { header: 'Previous', width: 0.24, align: 'right' }, { header: 'Current', width: 0.24, align: 'right' }, { header: 'Consumption', width: 0.24, align: 'right' }],
        bill.meters.map((m) => [`${m.serial} (${m.type})`, `${m.from}${m.fromAt ? ` · ${day(m.fromAt)}` : ''}`, `${m.to} · ${day(m.toAt)}`, String(m.consumption)]),
      );
    }
    if (bill.notes) {
      doc.moveDown(0.6);
      doc.font('Helvetica').fontSize(9).fillColor(GREY).text(`Note: ${bill.notes}`);
    }
    footer(doc, isInvoice ? 'This is a computer-generated tax invoice and does not need a signature.' : 'This is a computer-generated bill.');
  });
}

export function receiptPdf({ society, payment, bill, unit, creditBalance }) {
  return render((doc) => {
    header(doc, society, payment.status === 'bounced' ? 'RECEIPT (CANCELLED - BOUNCED)' : 'PAYMENT RECEIPT');
    facts(doc, [
      ['Receipt no.', payment.receiptNumber],
      ['Date', day(payment.paidAt)],
      ['Unit', unit?.label],
      ['Received from', payment.paidBy?.name || unit?.label],
    ]);
    doc.moveDown(0.5);
    const rows = [
      ['Mode', `${payment.method.toUpperCase()}${payment.reference ? ` · ${payment.reference}` : ''}`],
      ['Against', bill ? `${bill.billNumber} (${periodText(bill.period)})` : 'Advance payment'],
    ];
    if (bill && payment.appliedAmount != null && payment.appliedAmount !== payment.amount) rows.push(['Applied to bill', rs(payment.appliedAmount)]);
    if (payment.advanceAmount) rows.push(['Held as advance', rs(payment.advanceAmount)]);
    if (bill) rows.push(['Balance on bill', rs(Math.max(0, bill.total - bill.paid))]);
    rows.push(['Advance balance', rs(creditBalance)]);
    if (payment.status === 'bounced') rows.push(['Bounced', `${day(payment.bouncedAt)} · ${payment.bounceReason || ''}`]);
    rows.push(['Amount received', rs(payment.amount)]);
    table(doc, [{ header: 'Particulars', width: 0.55 }, { header: '', width: 0.45, align: 'right' }], rows, { boldLast: 1 });
    footer(doc, 'This is a computer-generated receipt. Cheque payments are subject to realisation.');
  });
}

export function statementPdf({ society, statement }) {
  return render((doc) => {
    header(doc, society, 'STATEMENT OF ACCOUNT');
    facts(doc, [
      ['Unit', statement.unit.label],
      ['Period', `${statement.from ? day(statement.from) : 'Beginning'} to ${day(statement.to)}`],
      ['Outstanding dues', rs(statement.outstanding)],
      ['Advance balance', rs(statement.creditBalance)],
    ]);
    doc.moveDown(0.5);
    const rows = [[statement.from ? day(statement.from) : '', 'Opening balance', '', '', rs(statement.openingBalance)]];
    for (const e of statement.entries) rows.push([day(e.date), e.description, e.debit ? rs(e.debit) : '', e.credit ? rs(e.credit) : '', rs(e.balance)]);
    rows.push(['', 'Closing balance', rs(statement.totals.debit), rs(statement.totals.credit), rs(statement.closingBalance)]);
    table(
      doc,
      [{ header: 'Date', width: 0.13 }, { header: 'Particulars', width: 0.39 }, { header: 'Debit', width: 0.16, align: 'right' }, { header: 'Credit', width: 0.16, align: 'right' }, { header: 'Balance', width: 0.16, align: 'right' }],
      rows,
      { boldLast: 1 },
    );
    footer(doc, 'Balance = amount payable; a negative balance is advance held for you.');
  });
}
