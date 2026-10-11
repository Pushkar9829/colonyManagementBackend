import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { localDateString } from '../../common/utils/dates.js';

// Row caps keep one request from tying up the API. CSV/Excel stream row by row, so their cap is high;
// PDF is laid out in memory by pdfkit and meant for printing, so it is kept short.
export const MAX_ROWS = 50000;
export const PDF_MAX_ROWS = 2000;

const IST = { timeZone: 'Asia/Kolkata' };
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-IN', { ...IST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

// Display value for CSV / PDF. Money columns are rupees with 2 decimals (API money is paise).
export function cell(col, row) {
  const v = row[col.key];
  if (v === undefined || v === null || v === '') return '';
  switch (col.format) {
    case 'money':
      return (Number(v) / 100).toFixed(2);
    case 'date':
      return v instanceof Date ? localDateString(v) : String(v);
    case 'datetime':
      return fmtDateTime(v);
    default:
      return Array.isArray(v) ? v.join(', ') : String(v);
  }
}

// Spreadsheet apps execute cells starting with = + - @ as formulas; prefix them so data stays data.
const defuse = (s) => (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s);
const csvField = (s) => {
  const v = defuse(s);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

async function* capped(rows, max, onCap) {
  let n = 0;
  for await (const row of rows) {
    if (n >= max) {
      onCap();
      return;
    }
    n += 1;
    yield row;
  }
}

export async function writeCsv(stream, report, rows) {
  const state = { truncated: false };
  stream.write('﻿'); // BOM so Excel opens UTF-8 (₹, names) correctly
  stream.write(`${report.columns.map((c) => csvField(c.header)).join(',')}\r\n`);
  let buffer = '';
  for await (const row of capped(rows, MAX_ROWS, () => (state.truncated = true))) {
    buffer += `${report.columns.map((c) => csvField(cell(c, row))).join(',')}\r\n`;
    if (buffer.length > 64 * 1024) {
      if (!stream.write(buffer)) await new Promise((r) => stream.once('drain', r));
      buffer = '';
    }
  }
  if (state.truncated) buffer += `${csvField(`Truncated at ${MAX_ROWS} rows - narrow the date range`)}\r\n`;
  stream.end(buffer);
  return state;
}

function xlsxValue(col, row) {
  const v = row[col.key];
  if (v === undefined || v === null) return null;
  if (col.format === 'money') return Number(v) / 100;
  if (col.format === 'datetime') return new Date(v);
  if (typeof v === 'number') return v;
  return defuse(Array.isArray(v) ? v.join(', ') : String(v));
}

function setupSheet(ws, report) {
  ws.columns = report.columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width || Math.max(12, c.header.length + 2),
    style: c.format === 'money' ? { numFmt: '#,##0.00' } : c.format === 'datetime' ? { numFmt: 'dd-mmm-yyyy hh:mm' } : {},
  }));
  ws.getRow(1).font = { bold: true };
}

// Streams an .xlsx straight to the response (ExcelJS streaming writer, constant memory).
export async function writeXlsx(stream, report, rows) {
  const state = { truncated: false };
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
  const ws = wb.addWorksheet(report.label.slice(0, 31));
  setupSheet(ws, report);
  ws.getRow(1).commit();
  for await (const row of capped(rows, MAX_ROWS, () => (state.truncated = true))) {
    ws.addRow(Object.fromEntries(report.columns.map((c) => [c.key, xlsxValue(c, row)]))).commit();
  }
  if (state.truncated) ws.addRow([`Truncated at ${MAX_ROWS} rows - narrow the date range`]).commit();
  ws.commit();
  await wb.commit();
  return state;
}

// In-memory workbook with several sheets (scheduled email attachments).
export async function xlsxBuffer(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ColonyHub';
  for (const { report, rows } of sheets) {
    const ws = wb.addWorksheet(report.label.slice(0, 31));
    setupSheet(ws, report);
    for (const row of rows) ws.addRow(Object.fromEntries(report.columns.map((c) => [c.key, xlsxValue(c, row)])));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Printable table. pdfkit builds pages as it goes and streams them to the response.
export async function writePdf(stream, report, rows, { title, subtitle } = {}) {
  const state = { truncated: false };
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  doc.pipe(stream);
  const done = new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  const left = 30;
  const usable = doc.page.width - 60;
  const weights = report.columns.map((c) => c.width || 12);
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / total) * usable);

  doc.fontSize(14).font('Helvetica-Bold').text(title || report.label);
  if (subtitle) doc.fontSize(9).font('Helvetica').fillColor('#64748b').text(subtitle).fillColor('#000');
  doc.moveDown(0.5);

  const header = () => {
    let x = left;
    const y = doc.y;
    doc.fontSize(8).font('Helvetica-Bold');
    report.columns.forEach((c, i) => {
      doc.text(c.header, x, y, { width: widths[i] - 4, ellipsis: true, lineBreak: false });
      x += widths[i];
    });
    doc.moveTo(left, y + 12).lineTo(left + usable, y + 12).strokeColor('#cbd5e1').stroke();
    doc.y = y + 16;
    doc.font('Helvetica');
  };
  header();
  for await (const row of capped(rows, PDF_MAX_ROWS, () => (state.truncated = true))) {
    if (doc.y > doc.page.height - 50) {
      doc.addPage();
      header();
    }
    let x = left;
    const y = doc.y;
    report.columns.forEach((c, i) => {
      // pdfkit's standard fonts lack the rupee sign; money is printed as plain numbers.
      doc.text(cell(c, row), x, y, { width: widths[i] - 4, ellipsis: true, lineBreak: false });
      x += widths[i];
    });
    doc.y = y + 13;
  }
  if (state.truncated) doc.moveDown().font('Helvetica-Oblique').text(`Showing the first ${PDF_MAX_ROWS} rows. Download CSV or Excel for the full report.`, left);
  doc.end();
  await done;
  return state;
}

export const FORMATS = {
  csv: { contentType: 'text/csv; charset=utf-8', ext: 'csv', write: writeCsv },
  xlsx: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', write: writeXlsx },
  pdf: { contentType: 'application/pdf', ext: 'pdf', write: writePdf },
};
