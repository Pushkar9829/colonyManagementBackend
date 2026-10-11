// Financial statements computed from journal lines. Dates are IST calendar days (YYYY-MM-DD strings),
// so range filters are plain string comparisons on JournalEntry.date.
import JournalEntry from './journalEntry.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { localDateString } from '../../common/utils/dates.js';
import { FUND_CODES, fyOf, fyRange, normalSide } from './chart.js';
import { accountsByCode } from './ledger.service.js';
import { balancesByCode, naturalBalance } from './accounting.service.js';

const LEDGER_ROW_CAP = 5000;

export function resolveRange({ from, to } = {}) {
  const today = localDateString();
  const end = to || today;
  const start = from || fyRange(fyOf(end)).from;
  if (start > end) throw ApiError.badRequest('"from" must be on or before "to"');
  return { from: start, to: end };
}

// Day before an ISO date (for "opening balance as of the day before from").
export function dayBefore(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const byCode = (a, b) => a.code.localeCompare(b.code);
const zero = { debit: 0, credit: 0 };

// ---------- account ledger ----------

export async function ledger(ctx, { code, from, to }) {
  const accounts = await accountsByCode(ctx.societyId);
  const account = accounts.get(code);
  if (!account) throw ApiError.notFound(`Account ${code} not found`);
  const range = resolveRange({ from, to });
  const before = await balancesByCode(ctx.societyId, { to: dayBefore(range.from) });
  const opening = naturalBalance(account.type, before.get(code));
  const sign = normalSide(account.type) === 'debit' ? 1 : -1;

  const raw = await JournalEntry.aggregate([
    { $match: { society: ctx.societyId, 'lines.code': code, date: { $gte: range.from, $lte: range.to } } },
    { $sort: { date: 1, number: 1 } },
    { $limit: LEDGER_ROW_CAP },
    { $project: { date: 1, number: 1, narration: 1, reference: 1, sourceType: 1, kind: 1, allCodes: '$lines.code', lines: 1 } },
    { $unwind: '$lines' },
    { $match: { 'lines.code': code } },
  ]);
  let balance = opening;
  const rows = raw.map((r) => {
    balance += sign * (r.lines.debit - r.lines.credit);
    const against = [...new Set(r.allCodes.filter((c) => c !== code))].map((c) => accounts.get(c)?.name || c);
    return {
      entryId: r._id,
      lineId: r.lines._id,
      date: r.date,
      number: r.number,
      narration: r.narration,
      reference: r.reference,
      sourceType: r.sourceType,
      memo: r.lines.memo,
      against: against.join(', '),
      debit: r.lines.debit,
      credit: r.lines.credit,
      balance,
    };
  });
  return {
    account: { _id: account._id, code: account.code, name: account.name, type: account.type, normalSide: normalSide(account.type) },
    ...range,
    opening,
    debit: rows.reduce((s, r) => s + r.debit, 0),
    credit: rows.reduce((s, r) => s + r.credit, 0),
    closing: balance,
    rows,
    truncated: raw.length >= LEDGER_ROW_CAP,
  };
}

// ---------- trial balance ----------

export async function trialBalance(ctx, { from, to }) {
  const range = resolveRange({ from, to });
  const accounts = await accountsByCode(ctx.societyId);
  const [before, during] = await Promise.all([
    balancesByCode(ctx.societyId, { to: dayBefore(range.from) }),
    balancesByCode(ctx.societyId, { from: range.from, to: range.to }),
  ]);
  const rows = [];
  for (const a of [...accounts.values()].sort(byCode)) {
    const o = before.get(a.code) || zero;
    const p = during.get(a.code) || zero;
    const openingNet = o.debit - o.credit;
    const closingNet = openingNet + p.debit - p.credit;
    if (!openingNet && !p.debit && !p.credit) continue;
    rows.push({
      code: a.code,
      name: a.name,
      type: a.type,
      openingDebit: Math.max(openingNet, 0),
      openingCredit: Math.max(-openingNet, 0),
      debit: p.debit,
      credit: p.credit,
      closingDebit: Math.max(closingNet, 0),
      closingCredit: Math.max(-closingNet, 0),
    });
  }
  const totals = ['openingDebit', 'openingCredit', 'debit', 'credit', 'closingDebit', 'closingCredit'].reduce(
    (t, k) => ({ ...t, [k]: rows.reduce((s, r) => s + r[k], 0) }),
    {},
  );
  return { ...range, rows, totals, balanced: totals.closingDebit === totals.closingCredit && totals.debit === totals.credit };
}

// ---------- income & expenditure ----------

export async function incomeExpenditure(ctx, { from, to }) {
  const range = resolveRange({ from, to });
  const accounts = await accountsByCode(ctx.societyId);
  const during = await balancesByCode(ctx.societyId, range);
  const section = (type) =>
    [...accounts.values()]
      .filter((a) => a.type === type)
      .sort(byCode)
      .map((a) => ({ code: a.code, name: a.name, amount: naturalBalance(a.type, during.get(a.code)) }))
      .filter((r) => r.amount !== 0);
  const income = section('income');
  const expenses = section('expense');
  const totalIncome = income.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);
  return { ...range, income, expenses, totalIncome, totalExpenses, surplus: totalIncome - totalExpenses };
}

// ---------- balance sheet ----------

export async function balanceSheet(ctx, { asOf }) {
  const date = asOf || localDateString();
  const accounts = await accountsByCode(ctx.societyId);
  const all = await balancesByCode(ctx.societyId, { to: date });
  const section = (type) =>
    [...accounts.values()]
      .filter((a) => a.type === type)
      .sort(byCode)
      .map((a) => ({ code: a.code, name: a.name, amount: naturalBalance(a.type, all.get(a.code)) }))
      .filter((r) => r.amount !== 0);
  const total = (rows) => rows.reduce((s, r) => s + r.amount, 0);
  const assets = section('asset');
  const liabilities = section('liability');
  const funds = section('equity');
  // Income and expense accounts are never closed, so their cumulative net is the accumulated surplus.
  const surplus = total(section('income')) - total(section('expense'));
  const totalAssets = total(assets);
  const totalLiabilities = total(liabilities);
  const totalFunds = total(funds) + surplus;
  return {
    asOf: date,
    assets,
    liabilities,
    funds,
    surplus,
    totalAssets,
    totalLiabilities,
    totalFunds,
    balanced: totalAssets === totalLiabilities + totalFunds,
  };
}

// ---------- fund balances ----------

export async function fundBalances(ctx, { from, to }) {
  const range = resolveRange({ from, to });
  const accounts = await accountsByCode(ctx.societyId);
  const fundAccounts = [...accounts.values()].filter((a) => FUND_CODES.includes(a.code) || FUND_CODES.includes(a.parent)).sort(byCode);
  const [before, during] = await Promise.all([
    balancesByCode(ctx.societyId, { to: dayBefore(range.from) }),
    balancesByCode(ctx.societyId, range),
  ]);
  const rows = fundAccounts.map((a) => {
    const opening = naturalBalance(a.type, before.get(a.code));
    const p = during.get(a.code) || zero;
    return { code: a.code, name: a.name, opening, additions: p.credit, utilised: p.debit, closing: opening + p.credit - p.debit };
  });
  const totals = ['opening', 'additions', 'utilised', 'closing'].reduce((t, k) => ({ ...t, [k]: rows.reduce((s, r) => s + r[k], 0) }), {});
  return { ...range, rows, totals };
}

// ---------- cash & bank book ----------

export async function cashBankBook(ctx, { from, to, code }) {
  const accounts = await accountsByCode(ctx.societyId);
  const books = [...accounts.values()].filter((a) => (code ? a.code === code : a.isBank || a.isCash)).sort(byCode);
  if (code && !books.length) throw ApiError.notFound(`Account ${code} not found`);
  if (code && !(books[0].isBank || books[0].isCash)) throw ApiError.badRequest(`${code} is not a cash or bank account`);
  const range = resolveRange({ from, to });
  const out = [];
  for (const a of books) {
    // eslint-disable-next-line no-await-in-loop
    const l = await ledger(ctx, { code: a.code, ...range });
    out.push({
      account: l.account,
      kind: a.isCash ? 'cash' : 'bank',
      opening: l.opening,
      receipts: l.debit,
      payments: l.credit,
      closing: l.closing,
      rows: l.rows.map((r) => ({ ...r, receipt: r.debit, payment: r.credit })),
      truncated: l.truncated,
    });
  }
  return { ...range, books: out };
}
