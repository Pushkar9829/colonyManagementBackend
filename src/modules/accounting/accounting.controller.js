import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import { localDateString } from '../../common/utils/dates.js';
import ApiError from '../../common/errors/ApiError.js';
import * as service from './accounting.service.js';
import * as reports from './reports.service.js';
import * as budgets from './budget.service.js';
import * as bank from './bank.service.js';
import * as exportsService from './exports.service.js';
import { syncSociety, syncStatus } from './sync.service.js';
import { statementMapping } from './accounting.validation.js';

export function sendFile(res, { buffer, contentType, filename }) {
  res.set({
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

// ---- chart & journal ----
export const listAccounts = asyncHandler(async (req, res) => ok(res, await service.listAccounts(ctx(req), query(req))));
export const createAccount = asyncHandler(async (req, res) => created(res, await service.createAccount(ctx(req), req.body)));
export const updateAccount = asyncHandler(async (req, res) => ok(res, await service.updateAccount(ctx(req), req.params.id, req.body)));

export const listJournals = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listJournals(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const getJournal = asyncHandler(async (req, res) => ok(res, await service.getJournal(ctx(req), req.params.id)));
export const createJournal = asyncHandler(async (req, res) => created(res, await service.createManualEntry(ctx(req), req.body)));
export const reverseJournal = asyncHandler(async (req, res) => created(res, await service.reverseManualEntry(ctx(req), req.params.id, req.body)));

export const getOpening = asyncHandler(async (req, res) => ok(res, await service.getOpeningBalances(ctx(req))));
export const postOpening = asyncHandler(async (req, res) => created(res, await service.postOpeningBalances(ctx(req), req.body)));

export const sync = asyncHandler(async (req, res) => {
  const result = await syncSociety(ctx(req), { full: Boolean(req.body?.full) });
  service.refresh(req.user.society);
  ok(res, result);
});
export const syncState = asyncHandler(async (req, res) => ok(res, await syncStatus(ctx(req))));

// ---- reports: JSON, or a file when ?format=xlsx|pdf ----
const REPORTS = {
  'trial-balance': (c, q) => reports.trialBalance(c, q),
  'income-expenditure': (c, q) => reports.incomeExpenditure(c, q),
  'balance-sheet': (c, q) => reports.balanceSheet(c, q),
  funds: (c, q) => reports.fundBalances(c, q),
  'cash-bank-book': (c, q) => reports.cashBankBook(c, q),
  ledger: (c, q) => reports.ledger(c, q),
};

async function respondReport(req, res, name, data) {
  const q = query(req);
  if (!q.format) return ok(res, data);
  const society = await exportsService.societyName(req.user.society);
  const file = await exportsService.render(exportsService.reportTable(name, data, society), q.format);
  const suffix = data.asOf || data.to || localDateString();
  const extra = name === 'ledger' ? `-${data.account.code}` : '';
  return sendFile(res, { ...file, filename: `${name}${extra}-${suffix}.${file.ext}` });
}

export const report = (name) =>
  asyncHandler(async (req, res) => {
    if (!REPORTS[name]) throw ApiError.notFound('Unknown report');
    const data = await REPORTS[name](ctx(req), query(req));
    return respondReport(req, res, name, data);
  });

export const tallyExport = asyncHandler(async (req, res) => {
  const q = query(req);
  if (q.kind === 'masters') {
    const xml = await exportsService.tallyMastersXml(ctx(req));
    return sendFile(res, { buffer: Buffer.from(xml, 'utf8'), contentType: 'application/xml; charset=utf-8', filename: 'tally-ledgers.xml' });
  }
  const out = await exportsService.tallyVouchersXml(ctx(req), q);
  return sendFile(res, { buffer: Buffer.from(out.xml, 'utf8'), contentType: 'application/xml; charset=utf-8', filename: `tally-vouchers-${out.from}-to-${out.to}.xml` });
});

export const journalExport = asyncHandler(async (req, res) => {
  const q = query(req);
  const range = reports.resolveRange(q);
  const buffer = await exportsService.journalExport(ctx(req), range);
  sendFile(res, { buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `journal-${range.from}-to-${range.to}.xlsx` });
});

// ---- budget ----
export const getBudget = asyncHandler(async (req, res) => ok(res, await budgets.getBudget(ctx(req), req.params.fy)));
export const saveBudget = asyncHandler(async (req, res) => ok(res, await budgets.saveBudget(ctx(req), req.params.fy, req.body)));
export const budgetReport = asyncHandler(async (req, res) => respondReport(req, res, 'budget', await budgets.budgetVsActual(ctx(req), req.params.fy)));

// ---- bank reconciliation ----
function parseMapping(raw) {
  if (raw === undefined || raw === '') return {};
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw ApiError.badRequest('mapping must be JSON');
    }
  }
  const parsed = statementMapping.safeParse(value);
  if (!parsed.success) throw ApiError.validation(parsed.error.issues.map((i) => ({ field: ['body', 'mapping', ...i.path].join('.'), message: i.message })));
  return parsed.data;
}

export const bankAccounts = asyncHandler(async (req, res) => ok(res, await bank.listBankAccounts(ctx(req))));
export const previewStatement = asyncHandler(async (req, res) => ok(res, await bank.previewStatement(ctx(req), req.params.code, req.file, parseMapping(req.body?.mapping))));
export const importStatement = asyncHandler(async (req, res) => created(res, await bank.importStatement(ctx(req), req.params.code, req.file, parseMapping(req.body?.mapping))));
export const listImports = asyncHandler(async (req, res) => ok(res, await bank.listImports(ctx(req), req.params.code)));
export const deleteImport = asyncHandler(async (req, res) => {
  await bank.deleteImport(ctx(req), req.params.id);
  noContent(res);
});
export const statementLines = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await bank.listLines(ctx(req), req.params.code, q, getPagination(q));
  ok(res, items, meta);
});
export const autoMatch = asyncHandler(async (req, res) => ok(res, await bank.autoMatch(ctx(req), req.params.code)));
export const reconciliation = asyncHandler(async (req, res) => ok(res, await bank.summary(ctx(req), req.params.code, query(req))));
export const candidates = asyncHandler(async (req, res) => ok(res, await bank.candidates(ctx(req), req.params.id)));
export const matchLine = asyncHandler(async (req, res) => ok(res, await bank.matchLine(ctx(req), req.params.id, req.body)));
export const unmatchLine = asyncHandler(async (req, res) => ok(res, await bank.unmatchLine(ctx(req), req.params.id)));
export const ignoreLine = asyncHandler(async (req, res) => ok(res, await bank.ignoreLine(ctx(req), req.params.id)));
export const createLineEntry = asyncHandler(async (req, res) => created(res, await bank.createEntryForLine(ctx(req), req.params.id, req.body)));
