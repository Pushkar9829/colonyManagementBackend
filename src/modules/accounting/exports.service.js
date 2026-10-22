// Excel / PDF rendering of reports, Tally XML and a flat journal export.
// Reports are first turned into a simple table spec so one writer serves every report:
//   { title, subtitle, columns: [{ header, key, type: 'text'|'money'|'pct', width }], rows: [{ ...values, _style? }] }
// _style: 'heading' (section title), 'total' (bold), 'muted'.
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import JournalEntry from './journalEntry.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { CODES, FUND_CODES } from './chart.js';
import { accountsByCode } from './ledger.service.js';
import { resolveRange } from './reports.service.js';

const MAX_EXPORT_ENTRIES = 20000;
const amountText = (paise) => (paise === null || paise === undefined || paise === '' ? '' : (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export async function societyName(societyId) {
  const s = await Society.findById(societyId).select('name').lean();
  return s?.name || 'Society';
}

// ---------- writers ----------

export async function toXlsx(spec) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ColonyHub';
  wb.created = new Date();
  const ws = wb.addWorksheet(spec.sheetName || spec.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  const width = spec.columns.length;
  ws.addRow([spec.title]).font = { bold: true, size: 14 };
  if (spec.subtitle) ws.addRow([spec.subtitle]).font = { color: { argb: 'FF64748B' } };
  ws.addRow([]);
  const header = ws.addRow(spec.columns.map((c) => c.header));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  });
  for (const r of spec.rows) {
    const row = ws.addRow(
      spec.columns.map((c) => {
        const v = r[c.key];
        if (v === undefined || v === null || v === '') return null;
        if (c.type === 'money') return v / 100;
        return v;
      }),
    );
    if (r._style === 'heading') row.font = { bold: true, color: { argb: 'FF1E293B' } };
    if (r._style === 'total') row.font = { bold: true };
    if (r._style === 'muted') row.font = { italic: true, color: { argb: 'FF64748B' } };
  }
  spec.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width || (c.type === 'money' ? 16 : c.type === 'pct' ? 10 : 24);
    if (c.type === 'money') col.numFmt = '#,##,##0.00;[Red]-#,##,##0.00';
    if (c.type === 'pct') col.numFmt = '0.0"%"';
  });
  ws.views = [{ state: 'frozen', ySplit: spec.subtitle ? 4 : 3 }];
  if (width > 1) ws.mergeCells(1, 1, 1, Math.min(width, 6));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(spec) {
  return new Promise((resolve, reject) => {
    const landscape = spec.columns.length > 6;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const usable = doc.page.width - left - doc.page.margins.right;
    const weights = spec.columns.map((c) => c.pdfWeight || (c.type === 'money' ? 1.1 : c.type === 'pct' ? 0.6 : c.key === 'code' ? 0.5 : 1.6));
    const totalW = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / totalW) * usable);
    const bottom = () => doc.page.height - doc.page.margins.bottom - 20;

    doc.font('Helvetica-Bold').fontSize(14).text(spec.title, left, doc.y);
    if (spec.subtitle) doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(spec.subtitle);
    doc.fillColor('#64748b').fontSize(8).text('Amounts in Indian Rupees');
    doc.fillColor('#000').moveDown(0.6);

    const drawRow = (values, { bold = false, fill } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      const heights = values.map((v, i) => doc.heightOfString(String(v ?? ''), { width: widths[i] - 6 }));
      const h = Math.max(12, ...heights) + 4;
      if (doc.y + h > bottom()) {
        doc.addPage();
        // eslint-disable-next-line no-use-before-define
        drawHeader();
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      }
      const y = doc.y;
      if (fill) doc.rect(left, y, usable, h).fill(fill).fillColor('#000');
      let x = left;
      values.forEach((v, i) => {
        const align = ['money', 'pct'].includes(spec.columns[i].type) ? 'right' : 'left';
        doc.text(String(v ?? ''), x + 3, y + 2, { width: widths[i] - 6, align });
        x += widths[i];
      });
      doc.y = y + h;
      doc.moveTo(left, doc.y).lineTo(left + usable, doc.y).lineWidth(0.3).strokeColor('#e2e8f0').stroke();
    };
    function drawHeader() {
      drawRow(spec.columns.map((c) => c.header), { bold: true, fill: '#f1f5f9' });
    }
    drawHeader();
    for (const r of spec.rows) {
      const values = spec.columns.map((c) => {
        const v = r[c.key];
        if (c.type === 'money') return amountText(v);
        if (c.type === 'pct') return v === null || v === undefined ? '' : `${v}%`;
        return v ?? '';
      });
      drawRow(values, { bold: r._style === 'heading' || r._style === 'total', fill: r._style === 'heading' ? '#f8fafc' : undefined });
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(7).fillColor('#94a3b8')
        .text(`Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} · Page ${i + 1} of ${range.count}`, left, doc.page.height - doc.page.margins.bottom - 10, { width: usable, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

export async function render(spec, format) {
  if (format === 'pdf') return { buffer: await toPdf(spec), contentType: 'application/pdf', ext: 'pdf' };
  return { buffer: await toXlsx(spec), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
}

// ---------- report -> table spec ----------

const rangeText = (r) => (r.asOf ? `As of ${r.asOf}` : `${r.from} to ${r.to}`);

export function reportTable(report, data, society) {
  const sub = (extra = '') => `${society} · ${rangeText(data)}${extra}`;
  switch (report) {
    case 'trial-balance':
      return {
        title: 'Trial balance',
        subtitle: sub(),
        columns: [
          { header: 'Code', key: 'code', width: 8 },
          { header: 'Account', key: 'name', width: 30 },
          { header: 'Opening Dr', key: 'openingDebit', type: 'money' },
          { header: 'Opening Cr', key: 'openingCredit', type: 'money' },
          { header: 'Debit', key: 'debit', type: 'money' },
          { header: 'Credit', key: 'credit', type: 'money' },
          { header: 'Closing Dr', key: 'closingDebit', type: 'money' },
          { header: 'Closing Cr', key: 'closingCredit', type: 'money' },
        ],
        rows: [...data.rows, { name: 'Total', ...data.totals, _style: 'total' }],
      };
    case 'income-expenditure':
      return {
        title: 'Income & expenditure',
        subtitle: sub(),
        columns: [{ header: 'Code', key: 'code', width: 8 }, { header: 'Account', key: 'name', width: 36 }, { header: 'Amount', key: 'amount', type: 'money' }],
        rows: [
          { name: 'Income', _style: 'heading' },
          ...data.income,
          { name: 'Total income', amount: data.totalIncome, _style: 'total' },
          { name: 'Expenditure', _style: 'heading' },
          ...data.expenses,
          { name: 'Total expenditure', amount: data.totalExpenses, _style: 'total' },
          { name: data.surplus >= 0 ? 'Surplus' : 'Deficit', amount: data.surplus, _style: 'total' },
        ],
      };
    case 'balance-sheet':
      return {
        title: 'Balance sheet',
        subtitle: sub(),
        columns: [{ header: 'Code', key: 'code', width: 8 }, { header: 'Account', key: 'name', width: 36 }, { header: 'Amount', key: 'amount', type: 'money' }],
        rows: [
          { name: 'Funds & reserves', _style: 'heading' },
          ...data.funds,
          { name: 'Accumulated surplus (income less expenditure)', amount: data.surplus },
          { name: 'Total funds', amount: data.totalFunds, _style: 'total' },
          { name: 'Liabilities', _style: 'heading' },
          ...data.liabilities,
          { name: 'Total liabilities', amount: data.totalLiabilities, _style: 'total' },
          { name: 'Total funds & liabilities', amount: data.totalFunds + data.totalLiabilities, _style: 'total' },
          { name: 'Assets', _style: 'heading' },
          ...data.assets,
          { name: 'Total assets', amount: data.totalAssets, _style: 'total' },
        ],
      };
    case 'funds':
      return {
        title: 'Fund balances',
        subtitle: sub(),
        columns: [
          { header: 'Code', key: 'code', width: 8 },
          { header: 'Fund', key: 'name', width: 28 },
          { header: 'Opening', key: 'opening', type: 'money' },
          { header: 'Additions', key: 'additions', type: 'money' },
          { header: 'Utilised', key: 'utilised', type: 'money' },
          { header: 'Closing', key: 'closing', type: 'money' },
        ],
        rows: [...data.rows, { name: 'Total', ...data.totals, _style: 'total' }],
      };
    case 'cash-bank-book': {
      const rows = [];
      for (const b of data.books) {
        rows.push({ narration: `${b.account.code} ${b.account.name}`, _style: 'heading' });
        rows.push({ narration: 'Opening balance', balance: b.opening, _style: 'muted' });
        for (const r of b.rows) rows.push({ date: r.date, number: r.number, narration: r.narration, against: r.against, receipt: r.receipt || null, payment: r.payment || null, balance: r.balance });
        rows.push({ narration: 'Closing balance', receipt: b.receipts, payment: b.payments, balance: b.closing, _style: 'total' });
      }
      return {
        title: 'Cash & bank book',
        subtitle: sub(),
        columns: [
          { header: 'Date', key: 'date', width: 12, pdfWeight: 0.8 },
          { header: 'Voucher', key: 'number', width: 12, pdfWeight: 0.8 },
          { header: 'Narration', key: 'narration', width: 40, pdfWeight: 2.2 },
          { header: 'Against', key: 'against', width: 24 },
          { header: 'Receipt', key: 'receipt', type: 'money' },
          { header: 'Payment', key: 'payment', type: 'money' },
          { header: 'Balance', key: 'balance', type: 'money' },
        ],
        rows,
      };
    }
    case 'ledger':
      return {
        title: `Ledger · ${data.account.code} ${data.account.name}`,
        subtitle: sub(data.truncated ? ' · first 5000 lines' : ''),
        columns: [
          { header: 'Date', key: 'date', width: 12, pdfWeight: 0.8 },
          { header: 'Voucher', key: 'number', width: 12, pdfWeight: 0.8 },
          { header: 'Narration', key: 'narration', width: 40, pdfWeight: 2.2 },
          { header: 'Against', key: 'against', width: 24 },
          { header: 'Debit', key: 'debit', type: 'money' },
          { header: 'Credit', key: 'credit', type: 'money' },
          { header: 'Balance', key: 'balance', type: 'money' },
        ],
        rows: [
          { narration: 'Opening balance', balance: data.opening, _style: 'muted' },
          ...data.rows.map((r) => ({ ...r, debit: r.debit || null, credit: r.credit || null })),
          { narration: 'Closing balance', debit: data.debit, credit: data.credit, balance: data.closing, _style: 'total' },
        ],
      };
    case 'budget':
      return {
        title: `Budget vs actual · FY ${data.label}`,
        subtitle: `${society} · actuals ${data.from} to ${data.to}`,
        columns: [
          { header: 'Code', key: 'code', width: 8 },
          { header: 'Account', key: 'name', width: 30 },
          { header: 'Budget', key: 'budget', type: 'money' },
          { header: 'Budget to date', key: 'budgetToDate', type: 'money' },
          { header: 'Actual', key: 'actual', type: 'money' },
          { header: 'Variance', key: 'variance', type: 'money' },
          { header: 'Variance %', key: 'variancePct', type: 'pct' },
        ],
        rows: [
          { name: 'Income', _style: 'heading' },
          ...data.income,
          { name: 'Total income', ...data.totals.income, _style: 'total' },
          { name: 'Expenditure', _style: 'heading' },
          ...data.expenses,
          { name: 'Total expenditure', ...data.totals.expenses, _style: 'total' },
        ],
      };
    default:
      throw ApiError.badRequest('Unknown report {report}', { params: { report } });
  }
}

// ---------- journal export (Excel, for Zoho Books / other software) ----------

async function entriesInRange(ctx, range) {
  const count = await JournalEntry.countDocuments({ society: ctx.societyId, date: { $gte: range.from, $lte: range.to } });
  if (count > MAX_EXPORT_ENTRIES) throw ApiError.badRequest('Too many entries ({count}). Export a shorter date range.', { params: { count } });
  return JournalEntry.find({ society: ctx.societyId, date: { $gte: range.from, $lte: range.to } })
    .sort({ date: 1, number: 1 })
    .populate([{ path: 'lines.unit', select: 'label' }, { path: 'lines.vendor', select: 'name' }])
    .lean();
}

export async function journalExport(ctx, { from, to }) {
  const range = resolveRange({ from, to });
  const [entries, accounts, society] = await Promise.all([entriesInRange(ctx, range), accountsByCode(ctx.societyId), societyName(ctx.societyId)]);
  const rows = [];
  for (const e of entries) {
    for (const l of e.lines) {
      rows.push({
        date: e.date,
        number: e.number,
        narration: e.narration,
        reference: e.reference,
        code: l.code,
        account: accounts.get(l.code)?.name || l.code,
        debit: l.debit || null,
        credit: l.credit || null,
        party: l.vendor?.name || l.unit?.label || '',
        source: e.sourceType || 'manual',
      });
    }
  }
  return toXlsx({
    title: 'Journal',
    sheetName: 'Journal',
    subtitle: `${society} · ${range.from} to ${range.to}`,
    columns: [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Voucher No', key: 'number', width: 12 },
      { header: 'Narration', key: 'narration', width: 44 },
      { header: 'Reference', key: 'reference', width: 18 },
      { header: 'Account Code', key: 'code', width: 12 },
      { header: 'Account', key: 'account', width: 28 },
      { header: 'Debit', key: 'debit', type: 'money' },
      { header: 'Credit', key: 'credit', type: 'money' },
      { header: 'Unit / Vendor', key: 'party', width: 20 },
      { header: 'Source', key: 'source', width: 16 },
    ],
    rows,
  });
}

// ---------- Tally XML ----------

const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const tallyAmount = (paise) => (paise / 100).toFixed(2);

// Tally ledger names must be unique; suffix the code when two accounts share a name.
function ledgerNames(accounts) {
  const counts = new Map();
  for (const a of accounts.values()) counts.set(a.name.toLowerCase(), (counts.get(a.name.toLowerCase()) || 0) + 1);
  const out = new Map();
  for (const a of accounts.values()) out.set(a.code, counts.get(a.name.toLowerCase()) > 1 ? `${a.name} (${a.code})` : a.name);
  return out;
}

function tallyGroup(a) {
  if (a.isBank) return 'Bank Accounts';
  if (a.isCash) return 'Cash-in-Hand';
  if (a.code === CODES.MAINTENANCE_RECEIVABLE || a.parent === CODES.MAINTENANCE_RECEIVABLE) return 'Sundry Debtors';
  if (a.code === CODES.VENDOR_PAYABLES || a.parent === CODES.VENDOR_PAYABLES) return 'Sundry Creditors';
  if ([CODES.TDS_PAYABLE, CODES.GST_PAYABLE].includes(a.code) || [CODES.TDS_PAYABLE, CODES.GST_PAYABLE].includes(a.parent)) return 'Duties & Taxes';
  if (a.code === CODES.OPENING_BALANCE_EQUITY) return 'Capital Account';
  if (FUND_CODES.includes(a.code) || FUND_CODES.includes(a.parent) || a.type === 'equity') return 'Reserves & Surplus';
  if (a.code === CODES.MAINTENANCE_INCOME || a.parent === CODES.MAINTENANCE_INCOME) return 'Sales Accounts';
  return { asset: 'Current Assets', liability: 'Current Liabilities', income: 'Indirect Incomes', expense: 'Indirect Expenses' }[a.type];
}

// Tally restricts cash/bank ledgers in Journal vouchers, so the type follows the money movement.
function voucherType(entry, accounts) {
  const money = entry.lines.filter((l) => accounts.get(l.code)?.isBank || accounts.get(l.code)?.isCash);
  if (money.length && money.length === entry.lines.length) return 'Contra';
  if (money.length) {
    const net = money.reduce((s, l) => s + l.debit - l.credit, 0);
    return net >= 0 ? 'Receipt' : 'Payment';
  }
  if (['bill', 'bill_late_fee'].includes(entry.sourceType)) return 'Sales';
  return 'Journal';
}

const envelope = (reportName, company, body) => `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>${reportName}</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${body}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;

export async function tallyMastersXml(ctx) {
  const [accounts, company] = await Promise.all([accountsByCode(ctx.societyId), societyName(ctx.societyId)]);
  const names = ledgerNames(accounts);
  const body = [...accounts.values()]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((a) => `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${xml(names.get(a.code))}" ACTION="Create">
            <NAME.LIST><NAME>${xml(names.get(a.code))}</NAME></NAME.LIST>
            <PARENT>${xml(tallyGroup(a))}</PARENT>
            <ISBILLWISEON>No</ISBILLWISEON>
          </LEDGER>
        </TALLYMESSAGE>`)
    .join('\n');
  return envelope('All Masters', company, body);
}

export async function tallyVouchersXml(ctx, { from, to }) {
  const range = resolveRange({ from, to });
  const [entries, accounts, company] = await Promise.all([entriesInRange(ctx, range), accountsByCode(ctx.societyId), societyName(ctx.societyId)]);
  const names = ledgerNames(accounts);
  const body = entries
    .map((e) => {
      const type = voucherType(e, accounts);
      const lines = e.lines
        .map((l) => {
          const isDebit = l.debit > 0;
          // Tally convention: debits are negative amounts with ISDEEMEDPOSITIVE=Yes.
          return `            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xml(names.get(l.code) || l.code)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
              <AMOUNT>${isDebit ? '-' : ''}${tallyAmount(isDebit ? l.debit : l.credit)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>`;
        })
        .join('\n');
      return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${type}" ACTION="Create" OBJVIEW="Accounting Voucher View">
            <DATE>${e.date.replace(/-/g, '')}</DATE>
            <VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xml(e.number)}</VOUCHERNUMBER>
            <REFERENCE>${xml(e.reference || '')}</REFERENCE>
            <NARRATION>${xml(e.narration)}</NARRATION>
            <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
${lines}
          </VOUCHER>
        </TALLYMESSAGE>`;
    })
    .join('\n');
  return { xml: envelope('Vouchers', company, body), count: entries.length, ...range };
}
