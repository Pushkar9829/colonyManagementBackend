import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import multer from 'multer';
import ApiError from '../../common/errors/ApiError.js';

export const MAX_SHEET_ROWS = 5000;

// Plain value of an exceljs cell (formula results, rich text and hyperlinks unwrapped).
function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    return '';
  }
  return v;
}

const headerKey = (h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

// Reads the first sheet of an .xlsx or .csv upload into objects keyed by a normalised header
// ("As of date" → "asofdate"). Rows that are completely empty are skipped; `row` is the sheet row number.
export async function readSheet(file) {
  if (!file?.buffer?.length) throw ApiError.badRequest('Attach an .xlsx or .csv file in the "file" field');
  const wb = new ExcelJS.Workbook();
  const isZip = file.buffer[0] === 0x50 && file.buffer[1] === 0x4b; // xlsx files are zip archives
  try {
    if (isZip) await wb.xlsx.load(file.buffer);
    else await wb.csv.read(Readable.from(file.buffer.toString('utf8')));
  } catch {
    throw ApiError.badRequest('Could not read the file. Upload an .xlsx or .csv file.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw ApiError.badRequest('The file has no sheet');
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = headerKey(cellValue(cell.value));
  });
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const obj = { row: n };
    let filled = false;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const v = cellValue(cell.value);
      if (v !== '') filled = true;
      obj[key] = typeof v === 'string' ? v.trim() : v;
    });
    if (filled) rows.push(obj);
  });
  if (rows.length > MAX_SHEET_ROWS) throw ApiError.badRequest(`At most ${MAX_SHEET_ROWS} rows per file`);
  return rows;
}

// "1,234.50" / 1234.5 → 1234.5 ; NaN when not a number.
export const parseNumber = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[,\s₹]/g, '')));

// Date cell or "YYYY-MM-DD" / "DD-MM-YYYY" / "DD/MM/YYYY" text → "YYYY-MM-DD", or null.
export function parseDateCell(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// Workbook with one styled sheet → Buffer, for downloads.
export async function workbookBuffer(sheetName, columns, rows, { title } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ColonyHub';
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 16, style: c.numFmt ? { numFmt: c.numFmt } : undefined }));
  if (title) {
    ws.spliceRows(1, 0, [title], []);
    ws.getRow(1).font = { bold: true, size: 13 };
  }
  const headerRow = ws.getRow(title ? 3 : 1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const sheetParser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file');

// Multipart middleware for spreadsheet imports ("file" field), with errors in the standard format.
export const receiveSheet = (req, res, next) =>
  sheetParser(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest('File is larger than 5 MB'));
    return next(ApiError.badRequest(err.message));
  });
