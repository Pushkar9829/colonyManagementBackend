import { Router } from 'express';
import multer from 'multer';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './accounting.controller.js';
import * as schema from './accounting.validation.js';

// Accounting is for the finance team only (admins always pass authorize()).
const { ACCOUNTANT } = ROLES;
const finance = authorize(ACCOUNTANT);

// Bank statements are parsed in memory and never stored as files.
const parser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file');
const receive = (req, res, next) =>
  parser(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest('Statement file is larger than 5 MB'));
    return next(ApiError.badRequest(err.message));
  });

const router = Router();
router.use(authenticate, requireSociety, finance);

// chart of accounts
router.get('/accounts', validate({ query: schema.listAccounts }), controller.listAccounts);
router.post('/accounts', validate({ body: schema.createAccount }), controller.createAccount);
router.patch('/accounts/:id', validate({ params: schema.idParams, body: schema.updateAccount }), controller.updateAccount);

// journal
router.get('/journals', validate({ query: schema.listJournals }), controller.listJournals);
router.post('/journals', validate({ body: schema.createJournal }), controller.createJournal);
router.get('/journals/:id', validate({ params: schema.idParams }), controller.getJournal);
router.post('/journals/:id/reverse', validate({ params: schema.idParams, body: schema.reverseJournal }), controller.reverseJournal);

router.get('/opening-balances', controller.getOpening);
router.post('/opening-balances', validate({ body: schema.openingBalances }), controller.postOpening);

// automatic posting from bills, payments, adjustments, amenities, payroll, vendor bills
router.get('/sync', controller.syncState);
router.post('/sync', validate({ body: schema.sync }), controller.sync);

// reports (add ?format=xlsx|pdf to download)
router.get('/reports/ledger', validate({ query: schema.ledgerQuery }), controller.report('ledger'));
router.get('/reports/trial-balance', validate({ query: schema.rangeQuery }), controller.report('trial-balance'));
router.get('/reports/income-expenditure', validate({ query: schema.rangeQuery }), controller.report('income-expenditure'));
router.get('/reports/balance-sheet', validate({ query: schema.asOfQuery }), controller.report('balance-sheet'));
router.get('/reports/funds', validate({ query: schema.rangeQuery }), controller.report('funds'));
router.get('/reports/cash-bank-book', validate({ query: schema.bookQuery }), controller.report('cash-bank-book'));

// exports for Tally / other accounting software
router.get('/exports/tally', validate({ query: schema.tallyQuery }), controller.tallyExport);
router.get('/exports/journal', validate({ query: schema.journalExportQuery }), controller.journalExport);

// budget (financial year April–March, :fy = starting year)
router.get('/budgets/:fy', validate({ params: schema.fyParams }), controller.getBudget);
router.put('/budgets/:fy', validate({ params: schema.fyParams, body: schema.saveBudget }), controller.saveBudget);
router.get('/budgets/:fy/report', validate({ params: schema.fyParams, query: schema.formatQuery }), controller.budgetReport);

// bank reconciliation
router.get('/bank/accounts', controller.bankAccounts);
router.delete('/bank/imports/:id', validate({ params: schema.idParams }), controller.deleteImport);
router.get('/bank/lines/:id/candidates', validate({ params: schema.idParams }), controller.candidates);
router.post('/bank/lines/:id/match', validate({ params: schema.idParams, body: schema.matchLine }), controller.matchLine);
router.post('/bank/lines/:id/unmatch', validate({ params: schema.idParams }), controller.unmatchLine);
router.post('/bank/lines/:id/ignore', validate({ params: schema.idParams }), controller.ignoreLine);
router.post('/bank/lines/:id/create-entry', validate({ params: schema.idParams, body: schema.createLineEntry }), controller.createLineEntry);
router.get('/bank/:code/lines', validate({ params: schema.codeParams, query: schema.statementLines }), controller.statementLines);
router.get('/bank/:code/imports', validate({ params: schema.codeParams }), controller.listImports);
router.get('/bank/:code/summary', validate({ params: schema.codeParams, query: schema.asOfQuery }), controller.reconciliation);
router.post('/bank/:code/preview', receive, validate({ params: schema.codeParams }), controller.previewStatement);
router.post('/bank/:code/import', receive, validate({ params: schema.codeParams }), controller.importStatement);
router.post('/bank/:code/auto-match', validate({ params: schema.codeParams }), controller.autoMatch);

export default router;
