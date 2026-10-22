// Bank reconciliation: import statements, match statement lines to journal lines on the bank account,
// and report book vs bank balance.
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import JournalEntry from './journalEntry.model.js';
import { BankStatementImport, BankStatementLine } from './bankStatement.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { localDateString } from '../../common/utils/dates.js';
import * as audit from '../audit/audit.service.js';
import { CODES } from './chart.js';
import { accountsByCode, postEntry, reverseEntryById } from './ledger.service.js';
import { balancesByCode, naturalBalance, refresh } from './accounting.service.js';
import { normalise, readRows } from './statementParser.js';

const MATCH_WINDOW_DAYS = 3;
const toId = (v) => new mongoose.Types.ObjectId(String(v));

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.abs(Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000));
const refKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function bankAccount(ctx, code) {
  const accounts = await accountsByCode(ctx.societyId);
  const account = accounts.get(code);
  if (!account) throw ApiError.notFound('Account {code} not found', { params: { code } });
  if (!account.isBank) throw ApiError.badRequest('{code} {name} is not a bank account', { params: { code, name: account.name } });
  return account;
}

async function loadLine(ctx, id) {
  const line = await BankStatementLine.findOne({ _id: id, society: ctx.societyId });
  if (!line) throw ApiError.notFound('Statement line not found');
  return line;
}

// Journal lines on a bank account, flattened: { entryId, lineId, date, number, narration, reference, debit, credit, reversed }
async function bookLines(ctx, code, { from, to, includeReversed = true } = {}) {
  const match = { society: ctx.societyId, 'lines.code': code };
  if (from || to) match.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (!includeReversed) Object.assign(match, { reversedBy: null, reversalOf: null });
  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.code': code } },
    { $sort: { date: 1, number: 1 } },
    {
      $project: {
        _id: 0, entryId: '$_id', lineId: '$lines._id', date: 1, number: 1, narration: 1, reference: 1,
        debit: '$lines.debit', credit: '$lines.credit', reversedBy: 1, reversalOf: 1,
      },
    },
  ]);
  return rows;
}

const matchedLineIds = async (ctx, code) =>
  new Set((await BankStatementLine.distinct('entryLines', { society: ctx.societyId, code, status: 'matched' })).map(String));

// ---------- accounts overview ----------

export async function listBankAccounts(ctx) {
  const accounts = [...(await accountsByCode(ctx.societyId)).values()].filter((a) => a.isBank).sort((a, b) => a.code.localeCompare(b.code));
  const balances = await balancesByCode(ctx.societyId, { to: localDateString() });
  const stats = await BankStatementLine.aggregate([
    { $match: { society: ctx.societyId } },
    { $group: { _id: '$code', unmatched: { $sum: { $cond: [{ $eq: ['$status', 'unmatched'] }, 1, 0] } }, lines: { $sum: 1 }, lastDate: { $max: '$date' } } },
  ]);
  const byCode = new Map(stats.map((s) => [s._id, s]));
  return accounts.map((a) => ({
    _id: a._id,
    code: a.code,
    name: a.name,
    bankDetails: a.bankDetails,
    active: a.active,
    bookBalance: naturalBalance(a.type, balances.get(a.code)),
    statementLines: byCode.get(a.code)?.lines || 0,
    unmatched: byCode.get(a.code)?.unmatched || 0,
    lastStatementDate: byCode.get(a.code)?.lastDate || null,
  }));
}

// ---------- import ----------

export async function previewStatement(ctx, code, file, mapping) {
  await bankAccount(ctx, code);
  if (!file) throw ApiError.badRequest('Attach the statement in the "file" field');
  const rows = await readRows(file.buffer, file.originalname);
  const parsed = normalise(rows, mapping);
  return { ...parsed, lines: parsed.lines.slice(0, 20), totalLines: parsed.lines.length, errors: parsed.errors.slice(0, 20) };
}

export async function importStatement(ctx, code, file, mapping = {}) {
  await bankAccount(ctx, code);
  if (!file) throw ApiError.badRequest('Attach the statement in the "file" field');
  const rows = await readRows(file.buffer, file.originalname);
  const parsed = normalise(rows, mapping);
  if (!parsed.lines.length) throw ApiError.badRequest('No transactions found in the statement. Check the column mapping.');

  const imp = await BankStatementImport.create({
    society: ctx.societyId,
    code,
    fileName: file.originalname?.slice(0, 120),
    rows: parsed.lines.length + parsed.errors.length,
    skipped: parsed.errors.length,
    from: parsed.lines.reduce((m, l) => (l.date < m ? l.date : m), parsed.lines[0].date),
    to: parsed.lines.reduce((m, l) => (l.date > m ? l.date : m), parsed.lines[0].date),
    uploadedBy: ctx.userId,
  });

  // Identical rows inside one file (two ₹500 UPI receipts the same day) get an occurrence number so
  // they stay distinct, while re-importing the same statement produces the same hashes.
  const seen = new Map();
  const docs = parsed.lines.map((l) => {
    const base = [l.date, l.deposit, l.withdrawal, refKey(l.reference), l.description.toUpperCase().replace(/\s+/g, ' ')].join('|');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return {
      society: ctx.societyId,
      code,
      import: imp._id,
      date: l.date,
      description: l.description,
      reference: l.reference || undefined,
      deposit: l.deposit,
      withdrawal: l.withdrawal,
      balance: l.balance,
      hash: crypto.createHash('sha1').update(`${base}|${n}`).digest('hex'),
    };
  });
  let inserted = 0;
  try {
    const res = await BankStatementLine.insertMany(docs, { ordered: false });
    inserted = res.length;
  } catch (err) {
    if (!err.writeErrors && err.code !== 11000) throw err;
    inserted = err.insertedDocs?.length ?? err.result?.insertedCount ?? docs.length - (err.writeErrors?.length || 0);
  }
  const auto = await autoMatch(ctx, code);
  await BankStatementImport.updateOne({ _id: imp._id }, { imported: inserted, duplicates: docs.length - inserted, autoMatched: auto.matched });
  audit.record(ctx, 'bank.statement_imported', 'BankStatementImport', imp._id, { code, imported: inserted, duplicates: docs.length - inserted });
  refresh(ctx.societyId);
  return { import: imp._id, imported: inserted, duplicates: docs.length - inserted, skipped: parsed.errors.length, errors: parsed.errors.slice(0, 20), autoMatched: auto.matched, columns: parsed.columns };
}

export const listImports = (ctx, code) =>
  BankStatementImport.find({ society: ctx.societyId, code }).sort({ createdAt: -1 }).limit(50).populate('uploadedBy', 'name').lean();

// Removes an import's lines (e.g. wrong file). Only possible while none of them is matched.
export async function deleteImport(ctx, id) {
  const imp = await BankStatementImport.findOne({ _id: id, society: ctx.societyId });
  if (!imp) throw ApiError.notFound('Import not found');
  if (await BankStatementLine.exists({ society: ctx.societyId, import: imp._id, status: 'matched' })) {
    throw ApiError.conflict('Unmatch the lines of this statement before removing it');
  }
  await BankStatementLine.deleteMany({ society: ctx.societyId, import: imp._id });
  await imp.deleteOne();
  audit.record(ctx, 'bank.statement_removed', 'BankStatementImport', imp._id, { code: imp.code, fileName: imp.fileName });
  refresh(ctx.societyId);
}

// ---------- matching ----------

/**
 * Pairs unmatched statement lines with unmatched journal lines on the same bank account:
 * same amount on the same side, dates within ±3 days; a matching reference/UTR ranks first,
 * then the closest date. Reversed entries (and their reversals) are left for manual matching.
 */
export async function autoMatch(ctx, code) {
  await bankAccount(ctx, code);
  const stmt = await BankStatementLine.find({ society: ctx.societyId, code, status: 'unmatched' }).lean();
  if (!stmt.length) return { matched: 0 };
  const dates = stmt.map((s) => s.date).sort();
  const book = await bookLines(ctx, code, { from: shiftDate(dates[0], -MATCH_WINDOW_DAYS), to: shiftDate(dates.at(-1), MATCH_WINDOW_DAYS), includeReversed: false });
  const taken = await matchedLineIds(ctx, code);
  const free = book.filter((b) => !taken.has(String(b.lineId)));

  const byAmount = new Map();
  for (const b of free) {
    const key = b.debit ? `D${b.debit}` : `C${b.credit}`;
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key).push(b);
  }
  const pairs = [];
  for (const s of stmt) {
    const key = s.deposit ? `D${s.deposit}` : `C${s.withdrawal}`;
    const sRef = refKey(s.reference);
    const sDesc = refKey(s.description);
    for (const b of byAmount.get(key) || []) {
      const gap = daysBetween(s.date, b.date);
      if (gap > MATCH_WINDOW_DAYS) continue;
      const bRef = refKey(b.reference);
      const refHit = bRef.length >= 4 && ((sRef && (sRef.includes(bRef) || bRef.includes(sRef))) || sDesc.includes(bRef));
      pairs.push({ s, b, score: (refHit ? 100 : 0) - gap * 10 });
    }
  }
  pairs.sort((x, y) => y.score - x.score || x.s.date.localeCompare(y.s.date));
  const usedS = new Set();
  const usedB = new Set();
  let matched = 0;
  for (const { s, b } of pairs) {
    const sid = String(s._id);
    const bid = String(b.lineId);
    if (usedS.has(sid) || usedB.has(bid)) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await BankStatementLine.updateOne(
      { _id: s._id, society: ctx.societyId, status: 'unmatched' },
      { status: 'matched', matchType: 'auto', entries: [b.entryId], entryLines: [b.lineId], matchedAt: new Date(), matchedBy: ctx.userId || undefined },
    );
    if (res.modifiedCount) {
      usedS.add(sid);
      usedB.add(bid);
      matched += 1;
    }
  }
  if (matched) refresh(ctx.societyId);
  return { matched };
}

export async function listLines(ctx, code, filters, pagination) {
  await bankAccount(ctx, code);
  const filter = { society: ctx.societyId, code };
  if (filters.status) filter.status = filters.status;
  if (filters.from || filters.to) filter.date = { ...(filters.from && { $gte: filters.from }), ...(filters.to && { $lte: filters.to }) };
  return paginate(BankStatementLine, filter, pagination, { sort: { date: -1, _id: 1 }, populate: { path: 'entries', select: 'number date narration' } });
}

// Unmatched journal lines that could clear this statement line (same side, ±15 days, closest amount first).
export async function candidates(ctx, id) {
  const line = await loadLine(ctx, id);
  const book = await bookLines(ctx, line.code, { from: shiftDate(line.date, -15), to: shiftDate(line.date, 15) });
  const taken = await matchedLineIds(ctx, line.code);
  const target = line.deposit || line.withdrawal;
  return book
    .filter((b) => !taken.has(String(b.lineId)) && (line.deposit ? b.debit > 0 : b.credit > 0))
    .map((b) => ({ ...b, amount: b.debit || b.credit, dateGap: daysBetween(b.date, line.date) }))
    .sort((a, b) => Math.abs(a.amount - target) - Math.abs(b.amount - target) || a.dateGap - b.dateGap)
    .slice(0, 50);
}

// Manual match to one or more journal lines whose net equals the statement line.
export async function matchLine(ctx, id, { entryLines }) {
  const line = await loadLine(ctx, id);
  if (line.status === 'matched') throw ApiError.conflict('Line is already matched. Unmatch it first.');
  const ids = [...new Set(entryLines.map(String))];
  const entries = await JournalEntry.find({ society: ctx.societyId, 'lines._id': { $in: ids.map(toId) } }).lean();
  const found = [];
  for (const e of entries) for (const l of e.lines) if (ids.includes(String(l._id))) found.push({ entry: e, line: l });
  if (found.length !== ids.length) throw ApiError.badRequest('One or more journal lines were not found');
  if (found.some((f) => f.line.code !== line.code)) throw ApiError.badRequest('Journal lines must be on the same bank account');
  const taken = await matchedLineIds(ctx, line.code);
  if (ids.some((x) => taken.has(x))) throw ApiError.conflict('A journal line is already matched to another statement line');
  const bookNet = found.reduce((s, f) => s + f.line.debit - f.line.credit, 0);
  const bankNet = line.deposit - line.withdrawal;
  if (bookNet !== bankNet) throw ApiError.badRequest('Amounts differ: statement {statement} vs books {books} (paise)', { params: { statement: bankNet, books: bookNet } });
  line.set({ status: 'matched', matchType: 'manual', entries: [...new Set(found.map((f) => String(f.entry._id)))], entryLines: ids, matchedAt: new Date(), matchedBy: ctx.userId });
  await line.save();
  refresh(ctx.societyId);
  return line.toObject();
}

export async function unmatchLine(ctx, id) {
  const line = await loadLine(ctx, id);
  if (line.status === 'unmatched') return line.toObject();
  // An entry created from this line (bank charge / interest) is reversed so the books follow.
  if (line.matchType === 'created') {
    for (const entryId of line.entries || []) {
      // eslint-disable-next-line no-await-in-loop
      await reverseEntryById(ctx, entryId, 'Bank statement line unmatched');
    }
  }
  line.set({ status: 'unmatched', matchType: undefined, entries: undefined, entryLines: undefined, matchedAt: undefined, matchedBy: undefined });
  await line.save();
  refresh(ctx.societyId);
  return line.toObject();
}

export async function ignoreLine(ctx, id) {
  const line = await loadLine(ctx, id);
  if (line.status === 'matched') throw ApiError.conflict('Unmatch the line before ignoring it');
  line.status = 'ignored';
  await line.save();
  refresh(ctx.societyId);
  return line.toObject();
}

const ENTRY_DEFAULTS = {
  bank_charge: { side: 'withdrawal', code: CODES.ADMIN_OFFICE, label: 'Bank charges' },
  interest: { side: 'deposit', code: CODES.INTEREST_INCOME, label: 'Bank interest' },
  other: { side: null, code: null, label: 'Bank transaction' },
};

// Books a line the society has not recorded yet (bank charges, interest, ...) and matches it.
export async function createEntryForLine(ctx, id, { kind, accountCode, narration }) {
  const line = await loadLine(ctx, id);
  if (line.status !== 'unmatched') throw ApiError.conflict('Only unmatched lines can be booked');
  const def = ENTRY_DEFAULTS[kind];
  const side = line.deposit ? 'deposit' : 'withdrawal';
  if (def.side && def.side !== side) throw ApiError.badRequest(kind === 'interest' ? 'Interest must be a deposit' : 'Bank charges must be a withdrawal');
  const code = accountCode || def.code || (side === 'deposit' ? CODES.OTHER_INCOME : CODES.OTHER_EXPENSES);
  if (code === line.code) throw ApiError.badRequest('Choose the other account of the transaction, not the bank itself');
  const amount = line.deposit || line.withdrawal;
  const n = await JournalEntry.countDocuments({ society: ctx.societyId, sourceType: 'bank_line', sourceRef: String(line._id) });
  const entry = await postEntry(ctx, {
    date: line.date,
    narration: narration || `${def.label}${line.description ? ` · ${line.description}` : ''}`.slice(0, 300),
    reference: line.reference,
    sourceType: 'bank_line',
    sourceId: `${line._id}:${n + 1}`,
    sourceRef: String(line._id),
    lines: side === 'deposit'
      ? [{ accountCode: line.code, debit: amount }, { accountCode: code, credit: amount }]
      : [{ accountCode: code, debit: amount }, { accountCode: line.code, credit: amount }],
  });
  const bankLine = entry.lines.find((l) => l.code === line.code);
  line.set({ status: 'matched', matchType: 'created', entries: [entry._id], entryLines: [bankLine._id], matchedAt: new Date(), matchedBy: ctx.userId });
  await line.save();
  audit.record(ctx, 'bank.entry_created', 'JournalEntry', entry._id, { kind, amount, code });
  refresh(ctx.societyId);
  return { line: line.toObject(), entry };
}

// ---------- summary ----------

/**
 * Bank reconciliation statement as of a date:
 *   expected bank balance = book balance
 *                           − book receipts not yet on the statement + book payments not yet on the statement
 *                           + statement credits not in the books − statement debits not in the books
 * difference = statement balance − expected (0 when fully reconciled).
 */
export async function summary(ctx, code, { asOf }) {
  const account = await bankAccount(ctx, code);
  const date = asOf || localDateString();
  const balances = await balancesByCode(ctx.societyId, { to: date });
  const bookBalance = naturalBalance(account.type, balances.get(code));

  const stmtAll = await BankStatementLine.find({ society: ctx.societyId, code, date: { $lte: date } }).sort({ date: 1, _id: 1 }).lean();
  const lastWithBalance = [...stmtAll].reverse().find((l) => typeof l.balance === 'number');
  const statementBalance = lastWithBalance ? lastWithBalance.balance : null;
  const unmatchedStmt = stmtAll.filter((l) => l.status === 'unmatched');

  // Only book lines from the statement period onwards are "outstanding"; older history predates the bank feed.
  const firstStmt = stmtAll[0]?.date;
  let unmatchedBook = [];
  if (firstStmt) {
    const taken = await matchedLineIds(ctx, code);
    const lines = (await bookLines(ctx, code, { from: shiftDate(firstStmt, -MATCH_WINDOW_DAYS), to: date })).filter((b) => !taken.has(String(b.lineId)));
    // a reversed entry and its reversal cancel out when neither reached the bank
    const ids = new Set(lines.map((l) => String(l.entryId)));
    unmatchedBook = lines.filter((l) => !(l.reversedBy && ids.has(String(l.reversedBy))) && !(l.reversalOf && ids.has(String(l.reversalOf))));
  }
  const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const bookReceiptsPending = sum(unmatchedBook, 'debit');
  const bookPaymentsPending = sum(unmatchedBook, 'credit');
  const bankCreditsUnrecorded = sum(unmatchedStmt, 'deposit');
  const bankDebitsUnrecorded = sum(unmatchedStmt, 'withdrawal');
  const expectedBankBalance = bookBalance - bookReceiptsPending + bookPaymentsPending + bankCreditsUnrecorded - bankDebitsUnrecorded;
  return {
    account: { code: account.code, name: account.name },
    asOf: date,
    bookBalance,
    statementBalance,
    statementBalanceDate: lastWithBalance?.date || null,
    bookReceiptsPending,
    bookPaymentsPending,
    bankCreditsUnrecorded,
    bankDebitsUnrecorded,
    expectedBankBalance,
    difference: statementBalance === null ? null : statementBalance - expectedBankBalance,
    counts: {
      statementLines: stmtAll.length,
      matched: stmtAll.filter((l) => l.status === 'matched').length,
      unmatchedStatement: unmatchedStmt.length,
      unmatchedBook: unmatchedBook.length,
      ignored: stmtAll.filter((l) => l.status === 'ignored').length,
    },
    unmatchedStatement: unmatchedStmt.slice(-200),
    unmatchedBook: unmatchedBook.slice(-200),
  };
}

