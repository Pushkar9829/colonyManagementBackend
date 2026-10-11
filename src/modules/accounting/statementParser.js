// Parses bank statements exported as CSV or XLSX into normalised lines.
// Banks differ wildly (header rows on line 1..15, "Withdrawal Amt." vs "Debit", single signed amount
// columns, "1,234.00 Dr" ...), so columns are auto-detected by header name and can be overridden
// with an explicit mapping { date, description, debit, credit, amount, type, reference, balance }.
import ExcelJS from 'exceljs';
import ApiError from '../../common/errors/ApiError.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Ordered by preference: the first synonym that matches wins.
const SYNONYMS = {
  date: ['date', 'txn date', 'transaction date', 'tran date', 'trans date', 'posting date', 'value date', 'value dt', 'txn dt'],
  description: ['description', 'narration', 'particulars', 'transaction details', 'details', 'transaction remarks', 'remarks'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'withdrawal amt', 'withdrawal amount', 'debit amount', 'debit amt', 'dr amount', 'dr'],
  credit: ['credit', 'deposit', 'deposits', 'deposit amt', 'deposit amount', 'credit amount', 'credit amt', 'cr amount', 'cr'],
  amount: ['amount', 'transaction amount', 'txn amount', 'amt'],
  type: ['dr cr', 'cr dr', 'type', 'transaction type', 'debit credit'],
  reference: ['reference', 'ref', 'ref no', 'reference no', 'reference number', 'utr', 'utr no', 'utr number', 'cheque no', 'chq no', 'chq ref no', 'cheque ref no', 'ref no cheque no', 'cheque number', 'instrument no'],
  balance: ['balance', 'closing balance', 'running balance', 'available balance', 'balance amt', 'balance amount'],
};
export const MAPPING_FIELDS = Object.keys(SYNONYMS);

function detectColumns(headers) {
  const h = headers.map(norm);
  const used = new Set();
  const out = {};
  for (const field of MAPPING_FIELDS) {
    for (const syn of SYNONYMS[field]) {
      let idx = h.findIndex((x, i) => !used.has(i) && x === syn);
      // loose match ("Txn Date (DD/MM/YYYY)") only for multi-word synonyms or long headers
      if (idx < 0 && syn.length > 3) idx = h.findIndex((x, i) => !used.has(i) && x.startsWith(`${syn} `));
      if (idx >= 0) {
        out[field] = idx;
        used.add(idx);
        break;
      }
    }
  }
  return out;
}

// Resolves a user mapping (header names or 0-based / letter column positions) to column indexes.
function applyMapping(headers, mapping = {}) {
  const auto = detectColumns(headers);
  const h = headers.map(norm);
  const out = { ...auto };
  for (const field of MAPPING_FIELDS) {
    const v = mapping[field];
    if (v === undefined || v === null || v === '') continue;
    if (v === false || v === '-') {
      delete out[field];
      continue;
    }
    let idx = -1;
    if (typeof v === 'number' || /^\d+$/.test(String(v))) idx = Number(v);
    else if (/^[A-Z]{1,2}$/.test(String(v))) idx = [...String(v)].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    else idx = h.indexOf(norm(v));
    if (idx < 0 || idx >= headers.length) throw ApiError.badRequest(`Column "${v}" for ${field} not found in the statement`);
    out[field] = idx;
  }
  return out;
}

// ---------- value parsing ----------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const year4 = (y) => (y < 100 ? 2000 + y : y);

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

export function parseDate(value, format = 'DMY') {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    // Excel serial date (days since 1899-12-30)
    if (value > 20000 && value < 80000) return new Date(Math.round((value - 25569) * 86400000)).toISOString().slice(0, 10);
    return null;
  }
  const s = String(value).trim().split(/\s+(?=\d{1,2}:\d{2})/)[0]; // drop a trailing time
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,4})[a-z]*[-/. ,]+(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return validDate(year4(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const [a, b, y] = [+m[1], +m[2], year4(+m[3])];
    return format === 'MDY' ? validDate(y, a, b) : validDate(y, b, a);
  }
  return null;
}

// "1,23,456.78", "₹ 500", "(250.00)", "1,000.00 Dr", "-75" -> signed paise. Empty -> 0. Garbage -> null.
export function parseAmount(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Math.round(value * 100);
  let s = String(value).trim();
  if (!s || s === '-') return 0;
  let sign = 1;
  if (/\bdr\.?$/i.test(s)) {
    sign = -1;
    s = s.replace(/\bdr\.?$/i, '');
  } else if (/\bcr\.?$/i.test(s)) s = s.replace(/\bcr\.?$/i, '');
  if (/^\(.*\)$/.test(s)) {
    sign = -sign;
    s = s.slice(1, -1);
  }
  s = s.replace(/[₹,\s]|INR|Rs\.?/gi, '');
  if (s.startsWith('-')) {
    sign = -sign;
    s = s.slice(1);
  }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  return sign * Math.round(Number(s) * 100);
}

const cellText = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return v.result ?? ''; // formula
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return v.text;
  }
  return v;
};

// ---------- file readers ----------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const delimiter = (text.split('\n', 1)[0].match(/;/g) || []).length > (text.split('\n', 1)[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}

async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw ApiError.badRequest('Could not read the Excel file. Save it as .xlsx or CSV and try again.');
  }
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const values = [];
    for (let c = 1; c <= r.cellCount; c += 1) values.push(cellText(r.getCell(c).value));
    rows.push(values.map((v) => (typeof v === 'string' ? v.trim() : v)));
  });
  return rows.filter((r) => r.some((x) => x !== '' && x !== null && x !== undefined));
}

export async function readRows(buffer, fileName = '') {
  if (!buffer?.length) throw ApiError.badRequest('The statement file is empty');
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b; // xlsx is a zip
  if (isZip || /\.xlsx$/i.test(fileName)) return readXlsx(buffer);
  if (/\.xls$/i.test(fileName)) throw ApiError.badRequest('Old .xls files are not supported. Save as .xlsx or CSV.');
  return parseCsv(buffer.toString('utf8').replace(/^﻿/, ''));
}

// Finds the header row: the first of the top 20 rows that names a date column and an amount column.
function findHeader(rows, mapping) {
  const limit = Math.min(rows.length, 20);
  for (let i = 0; i < limit; i += 1) {
    const headers = rows[i].map((x) => String(cellText(x) ?? ''));
    const cols = detectColumns(headers);
    const hasAmount = cols.amount !== undefined || cols.debit !== undefined || cols.credit !== undefined;
    if ((cols.date !== undefined && hasAmount) || (mapping?.headerRow !== undefined && mapping.headerRow === i)) return i;
  }
  return mapping?.headerRow ?? 0;
}

/**
 * Parses rows into { headers, columns, lines: [{ row, date, description, reference, deposit, withdrawal, balance }], errors }.
 * deposit/withdrawal are positive paise from the bank's point of view.
 */
export function normalise(rows, mapping = {}) {
  if (!rows.length) throw ApiError.badRequest('No rows found in the statement');
  const headerIdx = findHeader(rows, mapping);
  const headers = rows[headerIdx].map((x) => String(cellText(x) ?? '').trim());
  const columns = applyMapping(headers, mapping);
  if (columns.date === undefined) throw ApiError.badRequest('Could not find the date column. Map it explicitly.');
  if (columns.amount === undefined && columns.debit === undefined && columns.credit === undefined) {
    throw ApiError.badRequest('Could not find debit/credit or amount columns. Map them explicitly.');
  }
  const format = mapping.dateFormat || 'DMY';
  // For a single signed amount column, which sign means money in (default: positive = deposit).
  const positiveIsDeposit = mapping.amountSign !== 'positive_withdrawal';
  const lines = [];
  const errors = [];
  for (let i = headerIdx + 1; i < rows.length; i += 1) {
    const r = rows[i];
    const get = (f) => (columns[f] === undefined ? '' : cellText(r[columns[f]]));
    const rawDate = get('date');
    const date = parseDate(rawDate, format);
    if (!date) {
      // footer rows ("Closing balance", totals) have no date: skip quietly unless they look like data
      if (String(rawDate ?? '').trim()) errors.push({ row: i + 1, message: `Unreadable date "${rawDate}"` });
      continue;
    }
    let deposit = 0;
    let withdrawal = 0;
    if (columns.debit !== undefined || columns.credit !== undefined) {
      const dr = parseAmount(get('debit'));
      const cr = parseAmount(get('credit'));
      if (dr === null || cr === null) {
        errors.push({ row: i + 1, message: 'Unreadable amount' });
        continue;
      }
      withdrawal = Math.abs(dr);
      deposit = Math.abs(cr);
    } else {
      const amt = parseAmount(get('amount'));
      if (amt === null) {
        errors.push({ row: i + 1, message: 'Unreadable amount' });
        continue;
      }
      const type = norm(get('type'));
      let incoming;
      if (/^(cr|credit|c|deposit)$/.test(type)) incoming = true;
      else if (/^(dr|debit|d|withdrawal)$/.test(type)) incoming = false;
      else incoming = positiveIsDeposit ? amt > 0 : amt < 0;
      if (incoming) deposit = Math.abs(amt);
      else withdrawal = Math.abs(amt);
    }
    if (!deposit && !withdrawal) continue;
    if (deposit && withdrawal) {
      errors.push({ row: i + 1, message: 'Row has both a debit and a credit' });
      continue;
    }
    const bal = columns.balance === undefined ? null : parseAmount(get('balance'));
    lines.push({
      row: i + 1,
      date,
      description: String(get('description') ?? '').slice(0, 300),
      reference: String(get('reference') ?? '').slice(0, 80),
      deposit,
      withdrawal,
      balance: bal === null || get('balance') === '' ? undefined : bal,
    });
  }
  const columnNames = Object.fromEntries(Object.entries(columns).map(([k, idx]) => [k, headers[idx]]));
  return { headerRow: headerIdx, headers, columns: columnNames, lines, errors };
}
