import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './billing.service.js';
import * as adjustments from './adjustments.service.js';
import * as statements from './statement.service.js';
import { workbookBuffer } from './sheets.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sendFile = (res, type, { filename, buffer }) =>
  res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'private, no-store' }).send(buffer);

export const generate = asyncHandler(async (req, res) => created(res, await service.generate(ctx(req), req.body)));
export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), req.params.id)));
export const cancel = asyncHandler(async (req, res) => ok(res, await service.cancel(ctx(req), req.params.id)));
export const applyLateFees = asyncHandler(async (req, res) => ok(res, await service.applyLateFees(ctx(req))));
export const defaulters = asyncHandler(async (req, res) => ok(res, await service.defaulters(ctx(req))));
export const summary = asyncHandler(async (req, res) => ok(res, await service.summary(ctx(req), query(req).period)));
export const pdf = asyncHandler(async (req, res) => sendFile(res, 'application/pdf', await service.billPdfBuffer(ctx(req), req.params.id)));
export const email = asyncHandler(async (req, res) => ok(res, await service.emailBill(ctx(req), req.params.id)));

export const statement = asyncHandler(async (req, res) => ok(res, await statements.statement(ctx(req), query(req))));
export const statementPdf = asyncHandler(async (req, res) => sendFile(res, 'application/pdf', await statements.statementPdfBuffer(ctx(req), query(req))));
export const statementXlsx = asyncHandler(async (req, res) => sendFile(res, XLSX, await statements.statementXlsxBuffer(ctx(req), query(req))));

export const listAdjustments = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await adjustments.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const listWaivers = asyncHandler(async (req, res) => {
  const q = { ...query(req), type: 'waiver' };
  const { items, meta } = await adjustments.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const requestWaiver = asyncHandler(async (req, res) => created(res, await adjustments.requestWaiver(ctx(req), req.body)));
export const approveWaiver = asyncHandler(async (req, res) => ok(res, await adjustments.decideWaiver(ctx(req), req.params.id, 'approve', req.body.note)));
export const rejectWaiver = asyncHandler(async (req, res) => ok(res, await adjustments.decideWaiver(ctx(req), req.params.id, 'reject', req.body.note)));
export const creditHolders = asyncHandler(async (req, res) => ok(res, await adjustments.creditHolders(ctx(req))));
export const issueCredit = asyncHandler(async (req, res) => created(res, await adjustments.issueCredit(ctx(req), req.body)));
export const applyCredit = asyncHandler(async (req, res) => ok(res, await adjustments.applyCreditToOpenBills(ctx(req), req.body.unit)));
export const refund = asyncHandler(async (req, res) => created(res, await adjustments.refund(ctx(req), req.body)));

export const openingBalances = asyncHandler(async (req, res) => ok(res, await adjustments.importOpeningBalances(ctx(req), req.body.rows, { dryRun: req.body.dryRun })));
export const importOpeningBalances = asyncHandler(async (req, res) =>
  ok(res, await adjustments.importOpeningBalancesFile(ctx(req), req.file, { dryRun: ['true', '1', 'yes'].includes(String(req.body?.dryRun || '').toLowerCase()) })),
);
export const openingTemplate = asyncHandler(async (_req, res) => {
  const buffer = await workbookBuffer(
    'Opening balances',
    [
      { header: 'Unit', key: 'unit', width: 12 },
      { header: 'Amount', key: 'amount', width: 14 },
      { header: 'As of', key: 'asOf', width: 14 },
    ],
    [{ unit: 'A-101', amount: 4500, asOf: '2026-03-31' }, { unit: 'A-102', amount: -1000, asOf: '2026-03-31' }],
  );
  sendFile(res, XLSX, { filename: 'opening-balances-template.xlsx', buffer });
});
