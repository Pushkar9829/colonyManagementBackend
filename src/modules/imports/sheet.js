import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import ApiError from '../../common/errors/ApiError.js';

// Reads the first worksheet of an .xlsx or .csv upload into [{ header: value }] rows.
// Headers are matched case-insensitively and ignoring spaces/punctuation.
export const normKey = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.text) return String(v.text).trim(); // hyperlink / rich text
    if (v.result !== undefined) return String(v.result).trim(); // formula
    if (v.richText) return v.richText.map((r) => r.text).join('').trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

export async function readSheet(file) {
  if (!file) throw ApiError.badRequest('Attach a .xlsx or .csv file in the "file" field');
  const name = (file.originalname || '').toLowerCase();
  const wb = new ExcelJS.Workbook();
  try {
    if (name.endsWith('.csv')) await wb.csv.read(Readable.from(file.buffer));
    else await wb.xlsx.load(file.buffer);
  } catch {
    throw ApiError.badRequest('Could not read the file. Upload the template as .xlsx or .csv.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw ApiError.badRequest('The file has no sheet');
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = normKey(cellText(cell.value));
  });
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const obj = { _row: n };
    let any = false;
    headers.forEach((h, col) => {
      if (!h) return;
      const t = cellText(row.getCell(col).value);
      if (t) any = true;
      obj[h] = t;
    });
    if (any) rows.push(obj);
  });
  if (rows.length > 5000) throw ApiError.badRequest('At most 5000 rows per import');
  return rows;
}

export async function templateBuffer(columns, sample) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Import');
  ws.columns = columns.map((c) => ({ header: c, key: normKey(c), width: Math.max(14, c.length + 4) }));
  ws.getRow(1).font = { bold: true };
  for (const r of sample) ws.addRow(r);
  return wb.xlsx.writeBuffer();
}
